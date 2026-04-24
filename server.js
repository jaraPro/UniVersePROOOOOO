require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const xssClean = require('xss-clean');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const jwt = require('jsonwebtoken');

const {
  grantSubscription,
  hasSubscription,
  listPayments,
  listActiveSubscriptions,
} = require('./utils/subscriptionStore');
const { authenticateToken } = require('./backend/middleware/auth');
const User = require('./backend/models/User');

const app = express();
const DEFAULT_PORT = 5050;
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${DEFAULT_PORT}`;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const UNIVERSITY_ROOT = path.join(__dirname, 'univer');
let universityCatalogCache = null;

function normalizeForSearch(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function humanizeUniversityName(fileName) {
  const baseName = fileName.replace(/\.html$/i, '');
  return baseName
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectUniversityHtmlFiles(dirPath) {
  const files = [];
  const items = fs.readdirSync(dirPath, { withFileTypes: true });

  items.forEach((item) => {
    const absolutePath = path.join(dirPath, item.name);
    if (item.isDirectory()) {
      files.push(...collectUniversityHtmlFiles(absolutePath));
      return;
    }

    if (!item.isFile() || !item.name.toLowerCase().endsWith('.html')) {
      return;
    }

    const relativePath = path.relative(__dirname, absolutePath).split(path.sep).join('/');
    files.push({ absolutePath, relativePath, fileName: item.name });
  });

  return files;
}

function getUniversityCatalog() {
  if (universityCatalogCache) {
    return universityCatalogCache;
  }

  if (!fs.existsSync(UNIVERSITY_ROOT)) {
    universityCatalogCache = [];
    return universityCatalogCache;
  }

  const allFiles = collectUniversityHtmlFiles(UNIVERSITY_ROOT);

  // Prefer public preview pages (without trailing digit "1" before .html).
  universityCatalogCache = allFiles
    .filter((item) => !/\d+\.html$/i.test(item.fileName) || !/1\.html$/i.test(item.fileName))
    .map((item) => {
      const title = humanizeUniversityName(item.fileName);
      const normalizedTitle = normalizeForSearch(title);
      const normalizedPath = normalizeForSearch(item.relativePath);
      return {
        title,
        href: `/${item.relativePath}`,
        normalizedTitle,
        normalizedPath,
      };
    });

  return universityCatalogCache;
}

function extractUniversityNavigationQuery(message) {
  if (typeof message !== 'string') {
    return null;
  }

  const compact = message.trim();
  if (!compact) {
    return null;
  }

  const patterns = [
    /(?:зайди|открой|перейди|перейди в|зайти в|перейти в)\s+(?:в\s+)?(?:университет\s+)?(.+)/i,
    /(?:дай|пришли|скинь)\s+(?:ссылку\s+на|ссылку\s+в|ссылку\s+к)\s+(.+)/i,
    /(?:вуз|университет)\s+(.+)/i,
  ];

  for (const pattern of patterns) {
    const match = compact.match(pattern);
    if (match?.[1]) {
      return trimText(match[1], 200);
    }
  }

  return null;
}

function findUniversityByQuery(rawQuery) {
  const query = normalizeForSearch(trimText(rawQuery, 200));
  if (!query) {
    return null;
  }

  const catalog = getUniversityCatalog();
  if (!catalog.length) {
    return null;
  }

  let best = null;
  let bestScore = 0;

  const aliasMap = {
    kaznu: ['казну', 'казну имени аль-фараби', 'аль фараби', 'аль-фараби', 'kaznu'],
    kimep: ['кимэп', 'кимеп', 'kimep', 'kimep university'],
  };

  catalog.forEach((entry) => {
    let score = 0;
    const pathKey = path.basename(entry.href, '.html').toLowerCase();
    const aliases = aliasMap[pathKey] || [];

    if (entry.normalizedTitle === query) {
      score += 100;
    }
    if (entry.normalizedTitle.includes(query)) {
      score += 60;
    }
    if (query.includes(entry.normalizedTitle) && entry.normalizedTitle.length > 3) {
      score += 40;
    }
    if (entry.normalizedPath.includes(query)) {
      score += 25;
    }

    const queryWords = query.split(' ').filter(Boolean);
    queryWords.forEach((word) => {
      if (word.length >= 3 && entry.normalizedTitle.includes(word)) {
        score += 8;
      }
    });

    aliases.forEach((alias) => {
      const normalizedAlias = normalizeForSearch(alias);
      if (normalizedAlias === query) {
        score += 100;
      } else if (normalizedAlias.includes(query) || query.includes(normalizedAlias)) {
        score += 45;
      }
    });

    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  });

  if (!best || bestScore < 20) {
    return null;
  }

  return {
    title: best.title,
    href: best.href,
  };
}

function isThisUniversityReference(value) {
  const normalized = normalizeForSearch(trimText(value, 200));
  if (!normalized) {
    return false;
  }

  return [
    'этот университет',
    'этот вуз',
    'туда',
    'в него',
    'в этот университет',
    'в этот вуз',
  ].some((fragment) => normalized.includes(fragment));
}

function isUniversityNavigationIntent(value) {
  const normalized = normalizeForSearch(trimText(value, 250));
  if (!normalized) {
    return false;
  }

  return [
    'зайди',
    'зайти',
    'открой',
    'открыть',
    'перейди',
    'перейти',
    'закинь',
    'покажи страницу',
    'перенеси',
    'переведи',
    'отправь меня',
    'ссылку',
  ].some((fragment) => normalized.includes(fragment));
}

function parseSelectedUniversity(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const title = trimText(payload.title, 120);
  const href = trimText(payload.href, 250);

  if (!title || !href || !safePathInput(href)) {
    return null;
  }

  return { title, href };
}

function sanitizeHtmlText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveUniversityFilePath(href) {
  if (!safePathInput(href)) {
    return null;
  }

  const relative = href.startsWith('/') ? href.slice(1) : href;
  const resolved = path.join(__dirname, relative);

  if (!resolved.startsWith(UNIVERSITY_ROOT)) {
    return null;
  }

  if (!fs.existsSync(resolved)) {
    return null;
  }

  return resolved;
}

function extractUniversityContextFromHtml(html, href) {
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h2Match = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  const resolvedTitle = sanitizeHtmlText(h1Match?.[1] || h2Match?.[1] || titleMatch?.[1] || 'Университет');

  const paragraphMatches = Array.from(html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi));
  const paragraphs = paragraphMatches
    .map((item) => sanitizeHtmlText(item[1]))
    .filter(Boolean)
    .filter((item) => item.length >= 50)
    .slice(0, 3);

  const listMatches = Array.from(html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi));
  const items = listMatches
    .map((item) => sanitizeHtmlText(item[1]))
    .filter(Boolean)
    .filter((item) => item.length >= 10)
    .slice(0, 14);

  const facilities = items.slice(0, 6);
  const programs = items.slice(6, 12);

  return {
    title: resolvedTitle,
    href,
    shortDescription: paragraphs.join(' ').slice(0, 1000),
    facilities,
    programs,
    requiredDocuments: [
      'Удостоверение личности или паспорт',
      'Аттестат/диплом с приложением',
      'Сертификат ЕНТ или вступительного экзамена (если требуется)',
      'Фотографии установленного формата',
      'Медицинская справка и прививочный сертификат (по правилам вуза)',
      'Мотивационное письмо и CV (для отдельных программ)',
      'Языковой сертификат (IELTS/TOEFL), если программа требует',
    ],
  };
}

function getUniversityContextByHref(href) {
  const filePath = resolveUniversityFilePath(href);
  if (!filePath) {
    return null;
  }

  try {
    const html = fs.readFileSync(filePath, 'utf8');
    return extractUniversityContextFromHtml(html, href);
  } catch (_error) {
    return null;
  }
}

function buildLocalGuideReply(message, universityContext, matchedUniversity) {
  const normalizedMessage = normalizeForSearch(message);
  const wantsUniversityNavigation = isUniversityNavigationIntent(message);

  if (wantsUniversityNavigation && !matchedUniversity) {
    return [
      'Я понял, что ты хочешь перейти в университет на сайте.',
      'Но сейчас я не нашел такой вуз в каталоге UniVerse Pro.',
      'Попробуй написать точное название вуза так, как оно есть на сайте, и я сразу открою его страницу.',
    ].join('\n');
  }

  if (matchedUniversity && wantsUniversityNavigation) {
    return `Понял. Открываю страницу университета ${matchedUniversity.title}. Если переход не сработает автоматически, я оставлю карточку со ссылкой ниже.`;
  }

  if (matchedUniversity && !universityContext) {
    return [
      `Я нашел университет: ${matchedUniversity.title}.`,
      'Могу помочь дальше в нескольких форматах:',
      '• кратко объяснить, чем этот вуз может подойти',
      '• подсказать документы и шаги поступления',
      '• сразу открыть страницу этого университета на сайте',
      '',
      `Если хочешь перейти сразу, напиши: "зайди в ${matchedUniversity.title}".`,
    ].join('\n');
  }

  if (universityContext) {
    if (normalizedMessage.includes('документ') || normalizedMessage.includes('справк') || normalizedMessage.includes('бумаг')) {
      return [
        `Для поступления в ${universityContext.title} обычно готовят:`,
        ...universityContext.requiredDocuments.map((item, idx) => `${idx + 1}. ${item}`),
        '\nТочный список нужно сверить на официальной странице приемной комиссии этого вуза.',
      ].join('\n');
    }

    if (normalizedMessage.includes('что есть') || normalizedMessage.includes('факультет') || normalizedMessage.includes('программ') || normalizedMessage.includes('направлен') || normalizedMessage.includes('специальност')) {
      const facilities = universityContext.facilities.length
        ? universityContext.facilities.map((item) => `• ${item}`).join('\n')
        : '• Информация уточняется на странице университета';
      return [
        `По странице ${universityContext.title} видно, что в университете есть:`,
        facilities,
        '',
        `Хочешь узнать подробнее о конкретном направлении или документах для поступления?`,
      ].join('\n');
    }

    if (normalizedMessage.includes('стоимост') || normalizedMessage.includes('цен') || normalizedMessage.includes('сколько стоит') || normalizedMessage.includes('платн') || normalizedMessage.includes('грант')) {
      return `Точные данные о стоимости обучения в ${universityContext.title} лучше уточнить на официальном сайте приёмной комиссии — цены меняются каждый год. Могу рассказать про документы или специальности.`;
    }

    if (normalizedMessage.includes('общежит') || normalizedMessage.includes('кампус') || normalizedMessage.includes('жить') || normalizedMessage.includes('проживан')) {
      return [
        `По ${universityContext.title} лучше отдельно проверить раздел про общежитие и условия проживания на официальной странице вуза.`,
        'Если хочешь, я могу помочь составить список вопросов, которые стоит проверить перед подачей: стоимость, места, заселение, документы и сроки.',
      ].join('\n');
    }
  }

  // General questions without university context
  if (normalizedMessage.includes('привет') || normalizedMessage.includes('здравствуй') || normalizedMessage.includes('hello') || normalizedMessage.includes('hi')) {
    return 'Привет! Я ИИ-гид UniVerse Pro. Могу разговаривать с пользователем как живой консультант: помогу выбрать университет, направление, стратегию поступления, документы, гранты, визу, общежитие и быстро открою нужный вуз на сайте. Расскажи, что тебе нужно: выбрать вуз, сравнить варианты или сразу перейти в конкретный университет.';
  }

  if (normalizedMessage.includes('кто ты') || normalizedMessage.includes('что ты умеешь') || normalizedMessage.includes('чем поможешь')) {
    return [
      'Я ИИ-гид UniVerse Pro.',
      'Умею:',
      '• вести диалог как консультант по поступлению',
      '• помогать выбрать вуз под цель, город, бюджет и направление',
      '• объяснять документы, гранты, ЕНТ, общежитие и этапы поступления',
      '• находить университеты на сайте и открывать их по твоей команде',
      '',
      'Например, можешь написать: "подбери мне IT-вуз в Алматы" или "зайди в КБТУ".',
    ].join('\n');
  }

  if (normalizedMessage.includes('документ') || normalizedMessage.includes('справк') || normalizedMessage.includes('что нужно для поступлен')) {
    return [
      'Стандартный пакет документов для поступления в казахстанский вуз:',
      '1. Аттестат о среднем образовании (оригинал + копия)',
      '2. Результаты ЕНТ или вступительных экзаменов',
      '3. Удостоверение личности (оригинал + копия)',
      '4. Медицинская справка (форма 075-у или 086-у)',
      '5. Фотографии 3×4 (обычно 6-12 штук)',
      '6. Приписное свидетельство (для юношей)',
      '7. Заявление на поступление',
      '',
      '⚠️ Для конкретного вуза список может отличаться — уточни на официальном сайте. Хочешь найти конкретный университет?',
    ].join('\n');
  }

  if (normalizedMessage.includes('ент') || normalizedMessage.includes('экзамен') || normalizedMessage.includes('балл') || normalizedMessage.includes('порог')) {
    return [
      'О ЕНТ и вступительных экзаменах:',
      '',
      '• ЕНТ (Единое национальное тестирование) — основной способ поступления в казахстанские вузы',
      '• Минимальный пороговый балл для большинства специальностей — 50-65 баллов',
      '• Для государственных образовательных грантов нужен более высокий балл (от 70+)',
      '• Заявку на ЕНТ подают через портал Министерства просвещения РК',
      '',
      '📋 Хочешь, составлю план подготовки или помогу выбрать вуз под твой балл?',
    ].join('\n');
  }

  if (normalizedMessage.includes('виза') || normalizedMessage.includes('visa') || normalizedMessage.includes('за рубеж')) {
    return [
      'Если планируешь поступать за рубеж, я могу помочь с общим планом по визе и поступлению.',
      'Обычно нужно проверить:',
      '• приглашение или письмо о зачислении',
      '• финансовые документы',
      '• загранпаспорт',
      '• медицинскую страховку',
      '• визовую анкету и сроки подачи',
      '',
      'Если скажешь страну и вуз, я подскажу, на что обратить внимание в первую очередь.',
    ].join('\n');
  }

  if (normalizedMessage.includes('грант') || normalizedMessage.includes('стипенди') || normalizedMessage.includes('бесплатн') || normalizedMessage.includes('государствен')) {
    return [
      'О грантах на обучение в Казахстане:',
      '',
      '• Государственные образовательные гранты выдаются по результатам ЕНТ',
      '• Количество грантов ограничено и распределяется по специальностям',
      '• Также есть гранты "Болашак" — для обучения за рубежом',
      '• Гранты акиматов — дополнительные региональные квоты',
      '',
      '💡 Для получения гранта нужно набрать высокий балл по ЕНТ и попасть в конкурсный список. Хочешь узнать про конкретный вуз или специальность?',
    ].join('\n');
  }

  if (normalizedMessage.includes('план') || normalizedMessage.includes('как поступ') || normalizedMessage.includes('с чего начат') || normalizedMessage.includes('что делат')) {
    return [
      'План поступления в университет (шаг за шагом):',
      '',
      '1️⃣ Определись со специальностью и вузами (сделай топ-3 варианта)',
      '2️⃣ Зарегистрируйся на ЕНТ через портал Минпросвещения',
      '3️⃣ Подготовь документы заранее (список — нажми "Документы")',
      '4️⃣ Сдай ЕНТ и узнай результаты',
      '5️⃣ Подай заявку на грант через НАО "Государственная база данных «Е-лицензирование»"',
      '6️⃣ Подай документы в выбранные вузы (можно в несколько одновременно)',
      '7️⃣ Дождись зачисления и подпиши договор',
      '',
      '🎓 Хочешь, помогу выбрать университет или специальность?',
    ].join('\n');
  }

  if (normalizedMessage.includes('подбери') || normalizedMessage.includes('выбрать университет') || normalizedMessage.includes('какой университет') || normalizedMessage.includes('какой вуз')) {
    const wantsIt = normalizedMessage.includes('it') || normalizedMessage.includes('айти') || normalizedMessage.includes('информат') || normalizedMessage.includes('программ');
    const wantsBusiness = normalizedMessage.includes('бизнес') || normalizedMessage.includes('финанс') || normalizedMessage.includes('маркет');
    const wantsMedicine = normalizedMessage.includes('мед') || normalizedMessage.includes('стомат') || normalizedMessage.includes('фарма');
    const city = normalizedMessage.includes('алматы')
      ? 'Алматы'
      : normalizedMessage.includes('астана')
        ? 'Астана'
        : null;

    const direction = wantsIt
      ? 'IT и информатика'
      : wantsBusiness
        ? 'бизнес и финансы'
        : wantsMedicine
          ? 'медицина'
          : 'подходящее направление';

    return [
      `Помогу подобрать университет под ${direction}${city ? ` в городе ${city}` : ''}.`,
      'Чтобы совет был не шаблонный, напиши мне 3 вещи:',
      '1. какой город тебе нужен',
      '2. какое направление интересно',
      '3. важен ли бюджет, грант или общежитие',
      '',
      wantsIt
        ? 'Если хочешь, могу прямо сейчас предложить вузы для IT: например, AITU, КБТУ, КазНУ и другие варианты на сайте.'
        : 'Если хочешь, я могу сразу предложить 3-5 вузов и объяснить, чем они отличаются друг от друга.',
    ].join('\n');
  }

  if (normalizedMessage.includes('специальност') || normalizedMessage.includes('факультет') || normalizedMessage.includes('направлени') || normalizedMessage.includes('профессия') || normalizedMessage.includes('какую')) {
    return [
      'Популярные специальности и направления:',
      '',
      '💻 IT: Информационные системы, Программная инженерия, Кибербезопасность',
      '💼 Бизнес: Менеджмент, Финансы, Маркетинг, MBA',
      '⚕️ Медицина: Лечебное дело, Фармация, Стоматология',
      '⚖️ Право: Юриспруденция, Международное право',
      '🏗️ Техника: Строительство, Нефтегазовое дело, Машиностроение',
      '📚 Педагогика, Психология, Журналистика',
      '',
      '💡 Расскажи, что тебя интересует, и я помогу найти подходящий вуз!',
    ].join('\n');
  }

  if (normalizedMessage.includes('казну') || normalizedMessage.includes('кбту') || normalizedMessage.includes('aitu') || normalizedMessage.includes('нархоз') || normalizedMessage.includes('кимэп')) {
    const query = normalizedMessage.includes('казну') ? 'казну' :
                  normalizedMessage.includes('кбту') ? 'кбту' :
                  normalizedMessage.includes('aitu') ? 'aitu' :
                  normalizedMessage.includes('нархоз') ? 'нархоз' : 'кимэп';
    const found = findUniversityByQuery(query);
    if (found) {
      return `Нашел: ${found.title}!\nНапиши "зайди в ${found.title}", чтобы я показал кнопку перехода на страницу этого вуза.`;
    }
  }

  // Default response
  return [
    'Я ИИ-гид UniVerse Pro и могу вести полноценный диалог с пользователем.',
    '',
    'Могу помочь:',
    '• 📋 Документы для поступления',
    '• 🎓 Выбор университета и специальности',
    '• 📅 План поступления шаг за шагом',
    '• 🏫 Информация о конкретном вузе (напиши название)',
    '• 🎁 Гранты и стипендии',
    '• 🌍 Виза, общежитие и общая стратегия поступления',
    '• 🔗 Мгновенный переход на страницу нужного университета',
    '',
    'Напиши обычным языком, что тебе нужно. Например: "подбери мне IT-вуз в Алматы" или "зайди в университет КБТУ".',
  ].join('\n');
}

function injectScriptIntoHtml(html, src) {
  if (html.includes(src)) {
    return html;
  }

  const scriptTag = `<script src="${src}"></script>`;
  if (html.includes('</body>')) {
    return html.replace('</body>', `${scriptTag}\n</body>`);
  }
  return `${html}\n${scriptTag}`;
}

function trimText(value, maxLength = 1500) {
  if (typeof value !== 'string') {
    return '';
  }
  const cleaned = value.trim();
  if (!cleaned) {
    return '';
  }
  return cleaned.slice(0, maxLength);
}

function normalizeChatHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) {
    return [];
  }

  return rawHistory
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: trimText(item.content, 1200),
    }))
    .filter((item) => item.content)
    .slice(-8);
}

function buildAiGuideSystemPrompt() {
  return [
    'Ты профессиональный ИИ-гид платформы UniVerse Pro.',
    'Отвечай по-русски естественно, как умный живой консультант, но без воды и выдуманных фактов.',
    'Твоя задача: помогать с выбором университета, поступлением, документами, визой, грантами, общежитием и стратегией подготовки.',
    'Если данных недостаточно, задай 1-2 уточняющих вопроса и предложи практичный план действий.',
    'Когда пользователь спрашивает про конкретный университет, опирайся на переданный контекст университета и не выдумывай факты сверх него.',
    'Если пользователь просит открыть или показать университет на сайте, коротко подтверди действие и скажи, что страница будет открыта.',
    'По документам давай структурированный чек-лист и отдельно отмечай, что финальные требования нужно сверить на официальном сайте.',
    'Не выдумывай точные факты (дедлайны, цены, требования), если они неизвестны. Лучше явно пометь как "нужно уточнить на официальном сайте".',
    'Давай структурированные, полезные ответы уровня карьерного и образовательного консультанта.',
    'Избегай воды, токсичности и опасных советов.',
  ].join(' ');
}

function isPlaceholderValue(value) {
  if (!value || typeof value !== 'string') {
    return true;
  }
  return value.includes('REPLACE_WITH') || value.includes('xxxxxxxx') || value.includes('change_me');
}

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_REPLACE_WITH_YOUR_WEBHOOK_SECRET';

const KASPI_PAYMENT_LINK = process.env.KASPI_PAYMENT_LINK || '';
const KASPI_PHONE = process.env.KASPI_PHONE || '';
const KASPI_MERCHANT_NAME = process.env.KASPI_MERCHANT_NAME || '';
const KASPI_QR_IMAGE_URL = process.env.KASPI_QR_IMAGE_URL || '';

const stripeKeysConfigured = !isPlaceholderValue(STRIPE_SECRET_KEY) && !isPlaceholderValue(STRIPE_PUBLISHABLE_KEY);

let stripe = null;
if (stripeKeysConfigured) {
  stripe = require('stripe')(STRIPE_SECRET_KEY);
} else {
  console.warn('WARNING: Stripe keys are not configured. Set STRIPE_PUBLISHABLE_KEY and STRIPE_SECRET_KEY in .env');
}

// Для правильной работы хидера в продакшн через прокси (например, Heroku/Nginx)
app.set('trust proxy', 1);

// Безопасные заголовки
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://accounts.google.com", "https://js.stripe.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com", "data:"],
      imgSrc: ["'self'", "data:", "https:", "https://lh3.googleusercontent.com"],
      connectSrc: ["'self'", "https://accounts.google.com", "https://api.stripe.com", "https://r.stripe.com"],
      frameSrc: ["https://accounts.google.com", "https://js.stripe.com", "https://hooks.stripe.com"]
    }
  },
  hsts: {
    maxAge: 63072000,
    includeSubDomains: true,
    preload: true
  }
}));

// Предупреждение для разработки о секретах
if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET не задан, используется fallback. Установите переменную окружения для безопасности.');
}

// Заголовки дополнительной защиты
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=()');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

function safePathInput(value) {
  return typeof value === 'string' && value.startsWith('/univer/') && value.endsWith('.html');
}

function safeUniversityId(value) {
  return typeof value === 'string' && /^[\w\-/ .]+$/i.test(value) && value.startsWith('univer/') && value.endsWith('1');
}

function safeClientId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{6,120}$/.test(value);
}

async function optionalAuthenticateToken(req, _res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.slice('Bearer '.length);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);
    if (user) {
      req.user = user;
    }
  } catch (_error) {
    // Guest flow is allowed, ignore auth parse failures.
  }

  return next();
}

function resolveOwnerId(req, clientId) {
  if (req.user?._id) {
    return `user:${String(req.user._id)}`;
  }
  if (safeClientId(clientId)) {
    return `guest:${clientId}`;
  }
  return null;
}

function stripeReady(req, res, next) {
  if (!stripe) {
    return res.status(500).json({
      error: 'Stripe не настроен. Добавьте реальные STRIPE_PUBLISHABLE_KEY и STRIPE_SECRET_KEY в .env',
      code: 'stripe_not_configured',
    });
  }
  return next();
}

const adminEmails = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

function requireAdmin(req, res, next) {
  const userEmail = (req.user?.email || '').trim().toLowerCase();
  if (!userEmail || !adminEmails.includes(userEmail)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  return next();
}

// Webhook использует raw body, поэтому должен быть объявлен до express.json().
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || isPlaceholderValue(STRIPE_WEBHOOK_SECRET)) {
    return res.status(200).json({
      received: true,
      ignored: true,
      reason: 'webhook_not_configured',
    });
  }

  const signature = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    console.error('Stripe webhook signature error:', error.message);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const metadata = session.metadata || {};

    if (session.payment_status === 'paid' && metadata.ownerId && metadata.universityId) {
      grantSubscription(
        {
          id: metadata.ownerId,
          email: metadata.userEmail,
        },
        metadata.universityId,
        {
        provider: 'stripe',
        paymentFlow: metadata.paymentFlow || 'card',
        visaType: metadata.visaType || 'us',
        sessionId: session.id,
        }
      );
    }
  }

  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    const metadata = paymentIntent.metadata || {};

    if (metadata.ownerId && metadata.universityId) {
      grantSubscription(
        {
          id: metadata.ownerId,
          email: metadata.userEmail,
        },
        metadata.universityId,
        {
          provider: 'stripe',
          paymentFlow: metadata.paymentFlow || 'card',
          visaType: metadata.visaType || 'us',
          paymentIntentId: paymentIntent.id,
        }
      );
    }
  }

  return res.json({ received: true });
});

// Включаем CORS явно, ограничивая домены
const allowedOrigins = (process.env.CORS_ORIGIN || `http://localhost:3000,http://localhost:${DEFAULT_PORT}`).split(',');
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

const aiGuideLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: 'Слишком много запросов к ИИ-гиду. Попробуйте через минуту.',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    return res.status(429).json({
      error: 'Слишком много запросов к ИИ-гиду. Попробуйте через минуту.',
      code: 'ai_rate_limited',
    });
  },
});

app.post('/api/ai-guide/chat', aiGuideLimiter, async (req, res) => {
  try {
    const message = trimText(req.body?.message, 1500);
    const context = trimText(req.body?.context, 1500);
    const history = normalizeChatHistory(req.body?.history);
    const selectedUniversity = parseSelectedUniversity(req.body?.selectedUniversity);
    const universityContext = selectedUniversity?.href ? getUniversityContextByHref(selectedUniversity.href) : null;
    const navigationQuery = extractUniversityNavigationQuery(message) || extractUniversityNavigationQuery(context);
    const matchedByQuery = findUniversityByQuery(navigationQuery || message);
    const matchedUniversity = matchedByQuery || (isThisUniversityReference(message) ? selectedUniversity : null);
    const action = matchedUniversity && isUniversityNavigationIntent(message)
      ? {
          type: 'navigate-university',
          university: matchedUniversity,
        }
      : null;

    if (!message || message.length < 2) {
      return res.status(400).json({ error: 'Слишком короткий запрос к ИИ-гиду' });
    }

    const activeApiKey = GROQ_API_KEY || OPENAI_API_KEY;
    if (!activeApiKey) {
      return res.json({
        reply: buildLocalGuideReply(message, universityContext, matchedUniversity),
        model: 'local-router',
        createdAt: new Date().toISOString(),
        matchedUniversity,
        action,
      });
    }

    if (typeof fetch !== 'function') {
      return res.status(500).json({ error: 'Текущая версия Node.js не поддерживает fetch' });
    }

    const messages = [
      { role: 'system', content: buildAiGuideSystemPrompt() },
      ...(context ? [{ role: 'system', content: `Контекст пользователя: ${context}` }] : []),
      ...(universityContext
        ? [{ role: 'system', content: `Контекст университета: ${JSON.stringify(universityContext)}` }]
        : []),
      ...(matchedUniversity
        ? [{ role: 'system', content: `Если пользователь просит перейти в вуз, предложи эту ссылку: ${matchedUniversity.title} -> ${matchedUniversity.href}` }]
        : []),
      ...history,
      { role: 'user', content: message },
    ];

    const isGroq = Boolean(GROQ_API_KEY);
    const apiUrl = isGroq
      ? 'https://api.groq.com/openai/v1/chat/completions'
      : 'https://api.openai.com/v1/chat/completions';
    const model = isGroq ? GROQ_MODEL : OPENAI_MODEL;

    const aiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${activeApiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 800,
        messages,
      }),
    });

    if (!aiResponse.ok) {
      const errorPayload = await aiResponse.text();
      console.error('AI guide upstream error:', errorPayload);
      // Fallback to local reply instead of returning error to user
      return res.json({
        reply: buildLocalGuideReply(message, universityContext, matchedUniversity),
        model: 'local-router-fallback',
        createdAt: new Date().toISOString(),
        matchedUniversity,
        action,
      });
    }

    const data = await aiResponse.json();
    const reply = trimText(data?.choices?.[0]?.message?.content, 6000);

    if (!reply) {
      return res.json({
        reply: buildLocalGuideReply(message, universityContext, matchedUniversity),
        model: 'local-router-fallback',
        createdAt: new Date().toISOString(),
        matchedUniversity,
        action,
      });
    }

    return res.json({
      reply,
      model,
      createdAt: new Date().toISOString(),
      matchedUniversity,
      action,
    });
  } catch (error) {
    console.error('ai-guide chat error:', error);
    return res.status(500).json({ error: 'Не удалось получить ответ ИИ-гида' });
  }
});

app.get('/api/universities/context', (req, res) => {
  const href = trimText(req.query?.href, 250);
  if (!safePathInput(href)) {
    return res.status(400).json({ error: 'Некорректный href университета' });
  }

  const context = getUniversityContextByHref(href);
  if (!context) {
    return res.status(404).json({ error: 'Контекст университета не найден' });
  }

  return res.json({ context });
});

app.get('/api/universities/find', (req, res) => {
  const query = trimText(req.query?.q, 200);
  if (!query) {
    return res.status(400).json({ error: 'Параметр q обязателен' });
  }

  const match = findUniversityByQuery(query);
  return res.json({ match });
});

app.get('/api/payments/config', (req, res) => {
  return res.json({
    publishableKey: stripeKeysConfigured ? STRIPE_PUBLISHABLE_KEY : '',
    configured: stripeKeysConfigured,
    webhookConfigured: !isPlaceholderValue(STRIPE_WEBHOOK_SECRET),
  });
});

app.get('/api/payments/kaspi-config', (req, res) => {
  return res.json({
    configured: Boolean(KASPI_PAYMENT_LINK || KASPI_QR_IMAGE_URL || KASPI_PHONE),
    merchantName: KASPI_MERCHANT_NAME,
    phone: KASPI_PHONE,
    paymentLink: KASPI_PAYMENT_LINK,
    qrImageUrl: KASPI_QR_IMAGE_URL,
  });
});

app.post('/api/payments/create-checkout-session', optionalAuthenticateToken, stripeReady, async (req, res) => {
  try {
    const {
      universityId,
      premiumPath,
      previewPath,
      paymentFlow,
      visaType,
      clientId,
      cardLast4,
    } = req.body || {};

    if (!safeUniversityId(universityId) || !safePathInput(premiumPath) || !safePathInput(previewPath)) {
      return res.status(400).json({ error: 'Некорректные параметры оплаты' });
    }

    const ownerId = resolveOwnerId(req, clientId);
    if (!ownerId) {
      return res.status(400).json({ error: 'Нужен clientId или авторизация' });
    }

    const query = new URLSearchParams({
      universityId,
      premiumPath,
      previewPath,
    }).toString();

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: 100,
            product_data: {
              name: `FindU2 subscription: ${universityId}`,
              description: 'Доступ к полной информации конкретного университета',
            },
          },
        },
      ],
      success_url: `${APP_BASE_URL}/payment-success.html?${query}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_BASE_URL}${previewPath}`,
      metadata: {
        universityId,
        ownerId,
        userEmail: req.user?.email || '',
        premiumPath,
        previewPath,
        paymentFlow: paymentFlow === 'qr' ? 'qr' : 'card',
        visaType: visaType === 'kz' ? 'kz' : 'us',
        cardLast4: typeof cardLast4 === 'string' ? cardLast4.slice(-4) : '',
      },
    });

    let qrDataUrl = null;
    if (paymentFlow === 'qr') {
      qrDataUrl = await QRCode.toDataURL(session.url, {
        errorCorrectionLevel: 'M',
        width: 280,
      });
    }

    return res.json({
      sessionId: session.id,
      checkoutUrl: session.url,
      qrDataUrl,
    });
  } catch (error) {
    console.error('create-checkout-session error:', error);
    return res.status(500).json({ error: 'Не удалось создать платежную сессию' });
  }
});

app.post('/api/payments/create-payment-intent', optionalAuthenticateToken, stripeReady, async (req, res) => {
  try {
    const {
      universityId,
      premiumPath,
      previewPath,
      visaType,
      clientId,
    } = req.body || {};

    if (!safeUniversityId(universityId) || !safePathInput(premiumPath) || !safePathInput(previewPath)) {
      return res.status(400).json({ error: 'Некорректные параметры оплаты' });
    }

    const ownerId = resolveOwnerId(req, clientId);
    if (!ownerId) {
      return res.status(400).json({ error: 'Нужен clientId или авторизация' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: 100,
      currency: 'usd',
      payment_method_types: ['card'],
      metadata: {
        ownerId,
        universityId,
        userEmail: req.user?.email || '',
        premiumPath,
        previewPath,
        paymentFlow: 'card',
        visaType: visaType === 'kz' ? 'kz' : 'us',
      },
    });

    return res.json({
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
    });
  } catch (error) {
    console.error('create-payment-intent error:', error);
    return res.status(500).json({ error: 'Не удалось создать PaymentIntent' });
  }
});

app.post('/api/payments/confirm-payment-intent', optionalAuthenticateToken, stripeReady, async (req, res) => {
  try {
    const { paymentIntentId, universityId, clientId } = req.body || {};

    if (!paymentIntentId || !universityId) {
      return res.status(400).json({ error: 'Не хватает параметров подтверждения' });
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    const metadata = paymentIntent.metadata || {};
    const requesterOwnerId = resolveOwnerId(req, clientId);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(402).json({ error: 'Платеж не подтвержден' });
    }

    if (metadata.universityId !== universityId || !requesterOwnerId || metadata.ownerId !== requesterOwnerId) {
      return res.status(403).json({ error: 'Платеж не принадлежит этому пользователю или странице' });
    }

    grantSubscription({ id: requesterOwnerId, email: req.user?.email || metadata.userEmail || '' }, universityId, {
      provider: 'stripe',
      paymentFlow: metadata.paymentFlow || 'card',
      visaType: metadata.visaType || 'us',
      paymentIntentId: paymentIntent.id,
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('confirm-payment-intent error:', error);
    return res.status(500).json({ error: 'Не удалось подтвердить PaymentIntent' });
  }
});

app.get('/api/payments/session-status', optionalAuthenticateToken, stripeReady, async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    const clientId = req.query.clientId;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId обязателен' });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const paid = session.payment_status === 'paid';
    const metadata = session.metadata || {};
    const requesterOwnerId = resolveOwnerId(req, clientId);

    if (paid) {
      if (!requesterOwnerId || metadata.ownerId !== requesterOwnerId) {
        return res.status(403).json({ error: 'Платеж не принадлежит текущему пользователю' });
      }

      if (metadata.ownerId && metadata.universityId) {
        grantSubscription(
          {
            id: metadata.ownerId,
            email: metadata.userEmail,
          },
          metadata.universityId,
          {
          provider: 'stripe',
          paymentFlow: metadata.paymentFlow || 'card',
          visaType: metadata.visaType || 'us',
          sessionId: session.id,
          }
        );
      }
    }

    return res.json({
      paid,
      status: session.status,
      paymentStatus: session.payment_status,
    });
  } catch (error) {
    console.error('session-status error:', error);
    return res.status(500).json({ error: 'Не удалось проверить статус оплаты' });
  }
});

app.post('/api/payments/confirm-session', optionalAuthenticateToken, stripeReady, async (req, res) => {
  try {
    const { sessionId, universityId, clientId } = req.body || {};
    if (!sessionId || !universityId) {
      return res.status(400).json({ error: 'Не хватает параметров подтверждения' });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const metadata = session.metadata || {};

    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Платеж не подтвержден' });
    }

    const requesterOwnerId = resolveOwnerId(req, clientId);

    if (metadata.universityId !== universityId || !requesterOwnerId || metadata.ownerId !== requesterOwnerId) {
      return res.status(403).json({ error: 'Платеж не принадлежит этому пользователю или странице' });
    }

    grantSubscription({ id: requesterOwnerId, email: req.user?.email || '' }, universityId, {
      provider: 'stripe',
      paymentFlow: metadata.paymentFlow || 'card',
      visaType: metadata.visaType || 'us',
      sessionId: session.id,
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('confirm-session error:', error);
    return res.status(500).json({ error: 'Не удалось подтвердить платеж' });
  }
});

app.get('/api/subscriptions/status', optionalAuthenticateToken, (req, res) => {
  const universityId = req.query.universityId;
  const clientId = req.query.clientId;

  if (!universityId) {
    return res.status(400).json({ error: 'universityId обязателен' });
  }

  const ownerId = resolveOwnerId(req, clientId);
  if (!ownerId) {
    return res.json({ active: false });
  }

  return res.json({
    active: hasSubscription(ownerId, universityId),
  });
});

app.get('/api/admin/payments', authenticateToken, requireAdmin, (req, res) => {
  const limit = Number(req.query.limit || 500);
  return res.json({ items: listPayments(limit) });
});

app.get('/api/admin/subscriptions', authenticateToken, requireAdmin, (req, res) => {
  return res.json({ items: listActiveSubscriptions() });
});

function toSingleQueryValue(value) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === 'string' ? value : '';
}

function buildAuthModalRedirect(tab, query = {}) {
  const params = new URLSearchParams();
  params.set('auth', tab);

  const allowedParams = ['error', 'next'];
  allowedParams.forEach((key) => {
    const value = toSingleQueryValue(query[key]);
    if (value) {
      params.set(key, value);
    }
  });

  return `/index2.html?${params.toString()}`;
}

// Legacy auth entry points now use auth.js modal on index2.html.
app.get(['/login', '/login.html'], (req, res) => {
  res.redirect(302, buildAuthModalRedirect('login', req.query));
});

app.get(['/register', '/register.html'], (req, res) => {
  res.redirect(302, buildAuthModalRedirect('register', req.query));
});

// Добавляем глобальный launcher ИИ-гида на все HTML-страницы.
// Для страниц университетов дополнительно подключаем paywall.
app.get(/^\/.*\.html$/i, (req, res, next) => {
  const filePath = path.join(__dirname, decodeURIComponent(req.path));
  if (!filePath.startsWith(__dirname)) {
    return res.status(403).send('Forbidden');
  }

  fs.readFile(filePath, 'utf8', (error, html) => {
    if (error) {
      return next();
    }

    let updated = injectScriptIntoHtml(html, '/shared-navbar.js');
    updated = injectScriptIntoHtml(updated, '/ai-launcher.js');
    if (/^\/univer\/.*\.html$/i.test(req.path)) {
      updated = injectScriptIntoHtml(updated, '/subscription/paywall.js');
    }

    return res.type('html').send(updated);
  });
});

// Служим статичные файлы (HTML, CSS, JS)
app.use(express.static(path.join(__dirname)));

// Защита от NoSQL-инъекций
app.use(mongoSanitize());

// Защита от XSS
app.use(xssClean());

// rate limit для всех роутов
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 100,
  message: 'Слишком много запросов, попробуйте позже.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/universe';

mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log('MongoDB connected'))
  .catch((err) => {
    console.error('MongoDB connection error (continuing without DB-dependent features):', err.message || err);
  });

const backendAuthRoute = path.join(__dirname, 'backend', 'routes', 'auth.js');
const rootAuthRoute = path.join(__dirname, 'routes', 'auth.js');

// Prefer backend auth routes because they issue JWTs compatible with backend/middleware/auth.
if (fs.existsSync(backendAuthRoute)) {
  app.use('/api/auth', require('./backend/routes/auth'));
} else if (fs.existsSync(rootAuthRoute)) {
  app.use('/api/auth', require('./routes/auth'));
} else {
  console.warn('WARNING: auth route not found (./routes/auth.js or ./backend/routes/auth.js).');
}

// 404 обработчик
app.use((req, res) => {
  res.status(404).json({ message: 'Not Found' });
});

const PORT = Number(process.env.PORT) || DEFAULT_PORT;
const server = app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});

server.on('error', (error) => {
  if (error.code !== 'EADDRINUSE') {
    console.error('Server failed to start:', error.message);
    process.exitCode = 1;
    return;
  }

  console.error(
    `Port ${PORT} is already in use. Start the app with a free port, for example: PORT=${PORT + 1} npm start`
  );

  if (mongoose.connection.readyState !== 0) {
    mongoose.connection.close().finally(() => {
      process.exit(1);
    });
    return;
  }

  process.exit(1);
});