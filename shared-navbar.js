(function () {
  if (window.__findu2SharedNavbarMounted) {
    return;
  }
  window.__findu2SharedNavbarMounted = true;

  function ensureHeadAsset(tagName, attrs) {
    var selector = tagName;
    if (attrs.id) {
      selector += '#' + attrs.id;
    }
    var existing = document.querySelector(selector);
    if (existing) {
      return existing;
    }

    var el = document.createElement(tagName);
    Object.keys(attrs).forEach(function (key) {
      el.setAttribute(key, attrs[key]);
    });
    document.head.appendChild(el);
    return el;
  }

  ensureHeadAsset('link', {
    id: 'findu2-fa',
    rel: 'stylesheet',
    href: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
  });

  ensureHeadAsset('style', { id: 'findu2-shared-navbar-style' }).textContent = [
    'body { padding-top: 84px; }',
    '.navbar {',
    '  background: rgba(10, 12, 20, 0.72);',
    '  backdrop-filter: blur(12px);',
    '  border: 1px solid rgba(255,255,255,0.12);',
    '  color: #fff;',
    '  width: 100%;',
    '  margin: 0;',
    '  border-radius: 0;',
    '  padding: 1rem 2rem;',
    '  display: flex;',
    '  justify-content: space-between;',
    '  align-items: center;',
    '  position: fixed;',
    '  top: 0;',
    '  left: 0;',
    '  z-index: 1200;',
    '  box-shadow: 0 12px 28px rgba(0,0,0,0.28);',
    '}',
    '.navbar .logo {',
    '  font-size: 1.15rem;',
    '  font-weight: 600;',
    '  letter-spacing: 0.08em;',
    '  text-transform: uppercase;',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 0.5rem;',
    '}',
    '.navbar .nav-center {',
    '  display: flex;',
    '  flex: 1;',
    '  gap: 0.55rem;',
    '  justify-content: center;',
    '  margin: 0 1rem;',
    '}',
    '.navbar .nav-btn {',
    '  background: rgba(255,255,255,0.04);',
    '  color: #e8edff;',
    '  border: 1px solid rgba(255,255,255,0.16);',
    '  padding: 0.48rem 0.85rem;',
    '  border-radius: 999px;',
    '  cursor: pointer;',
    '  transition: all 0.3s;',
    '  font-size: 0.85rem;',
    '  font-weight: 600;',
    '}',
    '.navbar .nav-btn:hover { background: rgba(255,255,255,0.9); color: #101827; }',
    '.navbar .nav-btn.active-nav-btn {',
    '  background: rgba(255,255,255,0.9);',
    '  color: #101827;',
    '  border-color: rgba(255,255,255,0.95);',
    '}',
    '.navbar .nav-right { display: flex; gap: 1rem; align-items: center; }',
    '.navbar .user-info {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 0.8rem;',
    '  background: rgba(255,255,255,0.06);',
    '  padding: 0.5rem 1rem;',
    '  border-radius: 999px;',
    '  border: 1px solid rgba(255,255,255,0.13);',
    '  cursor: pointer;',
    '  transition: all 0.3s;',
    '}',
    '.navbar .user-avatar {',
    '  width: 32px;',
    '  height: 32px;',
    '  border-radius: 50%;',
    '  background: rgba(255,255,255,0.86);',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  font-weight: bold;',
    '  color: #111827;',
    '}',
    '@media (max-width: 768px) {',
    '  .navbar { min-width: 1200px; }',
    '  html, body { min-width: 1200px; overflow-x: auto; }',
    '}'
  ].join('\n');

  var path = window.location.pathname.toLowerCase();
  var isUniversityInner = path.indexOf('/univer/') !== -1;
  var isHome = path.endsWith('/index2.html') || path === '/' || path === '';
  var isUni = path.endsWith('/index5.html') || isUniversityInner || path.endsWith('/country.html') || path.endsWith('/sravnenie.html');
  var isInfo = path.endsWith('/info.html');
  var isDormitory = path.endsWith('/obshaga.html') || path.indexOf('/obshaga/') !== -1;
  var isAi = path.endsWith('/ai.html');

  var oldTopNav = document.querySelector('body > nav.navbar, body > header.navbar, body > header');
  if (oldTopNav) {
    oldTopNav.style.display = 'none';
  }

  var nav = document.createElement('nav');
  nav.className = 'navbar';
  nav.innerHTML = [
    '<div class="logo"><i class="fas fa-graduation-cap"></i> UniVerse Pro</div>',
    '<div class="nav-center">',
    '  <button class="nav-btn ' + (isHome ? 'active-nav-btn' : '') + '" data-href="/index2.html"><i class="fas fa-home"></i> Главная</button>',
    '  <button class="nav-btn ' + (isUni ? 'active-nav-btn' : '') + '" data-href="/index5.html"><i class="fas fa-university"></i> Университеты</button>',
    '  <button class="nav-btn ' + (isDormitory ? 'active-nav-btn' : '') + '" data-href="/obshaga/obshaga.html"><i class="fas fa-building"></i> Общежитие</button>',
    '  <button class="nav-btn ' + (isInfo ? 'active-nav-btn' : '') + '" data-href="/info.html"><i class="fas fa-info-circle"></i> О нас</button>',
    '  <button class="nav-btn ' + (isAi ? 'active-nav-btn' : '') + '" data-href="/AI.html"><i class="fas fa-robot"></i> AI-Гид</button>',
    '</div>',
    '<div class="nav-right">',
    '  <div class="user-info" id="userInfo" style="display:none;">',
    '    <div class="user-avatar" id="userAvatar">U</div>',
    '    <span id="userName">Пользователь</span>',
    '    <i class="fas fa-chevron-down"></i>',
    '  </div>',
    '  <button class="nav-btn" id="loginBtn"><i class="fas fa-sign-in-alt"></i> Вход/Регистрация</button>',
    '</div>'
  ].join('');

  document.body.insertBefore(nav, document.body.firstChild);

  nav.querySelectorAll('[data-href]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var href = btn.getAttribute('data-href');
      if (href) {
        window.location.href = href;
      }
    });
  });

  var userInfo = nav.querySelector('#userInfo');
  var loginBtn = nav.querySelector('#loginBtn');
  userInfo.addEventListener('click', function () {
    window.location.href = '/profile.html';
  });

  loginBtn.addEventListener('click', function () {
    if (window.universeAuth && typeof window.universeAuth.openModal === 'function') {
      window.universeAuth.openModal();
      return;
    }
    window.location.href = '/index2.html?auth=login';
  });

  var raw = localStorage.getItem('universe_currentUser');
  if (!raw) {
    return;
  }

  try {
    var userData = JSON.parse(raw);
    if (!userData || typeof userData !== 'object') {
      return;
    }

    var avatar = nav.querySelector('#userAvatar');
    var userName = nav.querySelector('#userName');
    var initials = (userData.name || 'U')
      .split(' ')
      .map(function (n) { return n[0]; })
      .join('')
      .toUpperCase()
      .slice(0, 2);

    avatar.textContent = initials || 'U';
    userName.textContent = userData.name || 'Пользователь';
    userInfo.style.display = 'flex';
    loginBtn.style.display = 'none';
  } catch (error) {
    console.warn('User data parse error', error);
  }
})();
