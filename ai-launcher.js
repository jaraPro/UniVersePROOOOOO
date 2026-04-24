(function () {
  'use strict';

  if (!window || !document || !document.body) {
    return;
  }

  var pathName = window.location.pathname || '';
  if (/\/AI\.html$/i.test(pathName)) {
    return;
  }

  var style = document.createElement('style');
  style.textContent = [
    '.findu2-ai-launcher {',
    '  position: fixed;',
    '  right: 16px;',
    '  bottom: 16px;',
    '  z-index: 99999;',
    '  border: none;',
    '  border-radius: 999px;',
    '  background: linear-gradient(120deg, #0f766e 0%, #0ea5a1 100%);',
    '  color: #ffffff;',
    '  padding: 12px 16px;',
    '  font: 600 14px/1 "Segoe UI", sans-serif;',
    '  cursor: pointer;',
    '  box-shadow: 0 12px 24px rgba(15, 118, 110, 0.35);',
    '}',
    '.findu2-ai-launcher:hover {',
    '  transform: translateY(-1px);',
    '}',
    '@media (max-width: 700px) {',
    '  .findu2-ai-launcher {',
    '    right: 10px;',
    '    bottom: 10px;',
    '    padding: 11px 14px;',
    '    font-size: 13px;',
    '  }',
    '}',
  ].join('\n');
  document.head.appendChild(style);

  var button = document.createElement('button');
  button.className = 'findu2-ai-launcher';
  button.type = 'button';
  button.textContent = 'AI-Гид';

  button.addEventListener('click', function () {
    var target = new URL('AI.html', window.location.href);
    var normalizedPath = pathName.replace(/^\/+/, '');
    var univerIndex = normalizedPath.toLowerCase().indexOf('univer/');
    if (univerIndex >= 0 && /\.html$/i.test(normalizedPath)) {
      target.searchParams.set('university', normalizedPath.slice(univerIndex));
    }
    window.location.href = target.toString();
  });

  document.body.appendChild(button);
})();
