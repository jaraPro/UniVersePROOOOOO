// Universe Auth - unified frontend auth helper for modal login/register
(function () {
  'use strict';

  class UniverseAuth {
    constructor() {
      this.baseURL = '/api/auth';
      this.accessToken = localStorage.getItem('universe_accessToken') || localStorage.getItem('accessToken') || localStorage.getItem('token') || '';
      this.refreshToken = localStorage.getItem('universe_refreshToken') || localStorage.getItem('refreshToken') || '';
      this.currentUser = this.readStoredUser();

      this.injectStyles();
      this.injectModal();
      this.updateUI();

      if (this.accessToken) {
        this.validateToken();
      }
    }

    readStoredUser() {
      try {
        const raw = localStorage.getItem('universe_currentUser');
        return raw ? JSON.parse(raw) : null;
      } catch (_e) {
        return null;
      }
    }

    splitName(fullName) {
      const safe = String(fullName || '').trim();
      if (!safe) {
        return { firstName: '', lastName: '' };
      }
      const parts = safe.split(/\s+/);
      return {
        firstName: parts[0] || '',
        lastName: parts.slice(1).join(' ') || '',
      };
    }

    normalizeUser(userPayload) {
      const u = userPayload?.user || userPayload || {};
      const firstName = String(u.firstName || '').trim();
      const lastName = String(u.lastName || '').trim();
      const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();

      return {
        id: u.id || u._id || Date.now(),
        email: u.email || '',
        firstName,
        lastName,
        name: fullName || u.name || u.email || 'Пользователь',
        phone: u.phone || '',
        city: u.city || '',
        bio: u.bio || '',
        isEmailVerified: Boolean(u.isEmailVerified),
        createdAt: u.createdAt || new Date().toISOString(),
      };
    }

    setAuthState({ accessToken, refreshToken, user }) {
      this.accessToken = accessToken || this.accessToken || '';
      this.refreshToken = refreshToken || this.refreshToken || '';
      this.currentUser = user ? this.normalizeUser(user) : this.currentUser;

      if (this.accessToken) {
        localStorage.setItem('universe_accessToken', this.accessToken);
        localStorage.setItem('accessToken', this.accessToken);
        localStorage.setItem('token', this.accessToken);
      }

      if (this.refreshToken) {
        localStorage.setItem('universe_refreshToken', this.refreshToken);
        localStorage.setItem('refreshToken', this.refreshToken);
      }

      if (this.currentUser) {
        localStorage.setItem('universe_currentUser', JSON.stringify(this.currentUser));
      }

      this.updateUI();
    }

    clearAuthState() {
      this.currentUser = null;
      this.accessToken = '';
      this.refreshToken = '';

      [
        'universe_accessToken',
        'accessToken',
        'token',
        'universe_refreshToken',
        'refreshToken',
        'universe_currentUser',
      ].forEach((k) => localStorage.removeItem(k));

      this.updateUI();
    }

    async validateToken() {
      try {
        const response = await fetch(`${this.baseURL}/profile`, {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
          },
        });

        if (response.ok) {
          const data = await response.json();
          this.setAuthState({ user: data.user || data });
          return;
        }

        if (response.status === 401 || response.status === 403) {
          await this.refreshAccessToken();
          return;
        }
      } catch (_e) {
        // Ignore network errors here; keep local state if available.
      }

      this.updateUI();
    }

    async refreshAccessToken() {
      if (!this.refreshToken) {
        this.clearAuthState();
        return;
      }

      try {
        const response = await fetch(`${this.baseURL}/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: this.refreshToken }),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.accessToken) {
          this.clearAuthState();
          return;
        }

        this.setAuthState({ accessToken: data.accessToken, refreshToken: data.refreshToken || this.refreshToken });
        await this.validateToken();
      } catch (_e) {
        this.clearAuthState();
      }
    }

    async register(name, email, phone, password) {
      const split = this.splitName(name);
      try {
        this.showLoading('Регистрация...');
        const response = await fetch(`${this.baseURL}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            firstName: split.firstName,
            lastName: split.lastName || '-',
            email,
            password,
            phone,
          }),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          return { success: false, error: data.error || 'Ошибка регистрации' };
        }

        const token = data.accessToken || data.token || '';
        this.setAuthState({
          accessToken: token,
          refreshToken: data.refreshToken || '',
          user: data.user || { firstName: split.firstName, lastName: split.lastName, email },
        });

        return { success: true, user: this.currentUser };
      } catch (_e) {
        return { success: false, error: 'Ошибка сети. Попробуйте позже.' };
      } finally {
        this.hideLoading();
      }
    }

    async login(email, password, twoFactorCode) {
      try {
        this.showLoading('Вход...');
        const response = await fetch(`${this.baseURL}/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, twoFactorCode }),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (data.requiresTwoFactor || data.requires2FA) {
            return { success: false, requires2FA: true, error: 'Введите код 2FA' };
          }
          return { success: false, error: data.error || 'Ошибка входа' };
        }

        this.setAuthState({
          accessToken: data.accessToken || data.token || '',
          refreshToken: data.refreshToken || '',
          user: data.user,
        });

        return { success: true, user: this.currentUser };
      } catch (_e) {
        return { success: false, error: 'Ошибка сети. Попробуйте позже.' };
      } finally {
        this.hideLoading();
      }
    }

    async logout() {
      try {
        if (this.accessToken) {
          await fetch(`${this.baseURL}/logout`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.accessToken}`,
            },
            body: JSON.stringify({ refreshToken: this.refreshToken || '' }),
          });
        }
      } catch (_e) {
        // Ignore logout network errors.
      }
      this.clearAuthState();
      this.showSuccess('Выход выполнен');
    }

    isAuthenticated() {
      return Boolean(this.accessToken && this.currentUser);
    }

    async addToFavorites(universityId) {
      if (!this.accessToken) {
        return { success: false, error: 'Необходимо войти в аккаунт' };
      }

      try {
        const response = await fetch(`${this.baseURL}/add-favorite`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.accessToken}`,
          },
          body: JSON.stringify({ universityId }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          return { success: false, error: data.error || 'Ошибка добавления в избранное' };
        }
        return { success: true, favorites: data.favorites || [] };
      } catch (_e) {
        return { success: false, error: 'Ошибка сети' };
      }
    }

    async removeFromFavorites(universityId) {
      if (!this.accessToken) {
        return { success: false, error: 'Необходимо войти в аккаунт' };
      }

      try {
        const response = await fetch(`${this.baseURL}/remove-favorite`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.accessToken}`,
          },
          body: JSON.stringify({ universityId }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          return { success: false, error: data.error || 'Ошибка удаления из избранного' };
        }
        return { success: true, favorites: data.favorites || [] };
      } catch (_e) {
        return { success: false, error: 'Ошибка сети' };
      }
    }

    async getFavorites() {
      if (!this.accessToken) {
        return { success: false, error: 'Необходимо войти в аккаунт' };
      }

      try {
        const response = await fetch(`${this.baseURL}/favorites`, {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
          },
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          return { success: false, error: data.error || 'Ошибка загрузки избранного' };
        }
        return { success: true, favorites: data.favorites || [] };
      } catch (_e) {
        return { success: false, error: 'Ошибка сети' };
      }
    }

    injectStyles() {
      if (document.getElementById('universe-auth-styles')) return;
      const style = document.createElement('style');
      style.id = 'universe-auth-styles';
      style.textContent = `
        .universe-auth-modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:10000; align-items:center; justify-content:center; }
        .universe-auth-modal.active { display:flex; }
        .universe-auth-content { width:min(520px,94vw); background:#fff; border-radius:16px; padding:1.2rem; box-shadow:0 20px 60px rgba(0,0,0,.25); }
        .universe-auth-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
        .universe-auth-title { margin:0; color:#062abb; font-size:1.2rem; }
        .universe-auth-close { border:none; background:transparent; font-size:1.6rem; cursor:pointer; }
        .universe-auth-tabs { display:flex; gap:8px; margin-bottom:12px; }
        .universe-auth-tab { flex:1; border:none; background:#eef3ff; color:#062abb; border-radius:10px; padding:.65rem; font-weight:700; cursor:pointer; }
        .universe-auth-tab.active { background:#062abb; color:#fff; }
        .universe-auth-tab-content { display:none; }
        .universe-auth-tab-content.active { display:block; }
        .universe-form-group { margin-bottom:10px; }
        .universe-form-group label { display:block; margin-bottom:4px; font-weight:600; color:#2b2b2b; }
        .universe-form-group input { width:100%; padding:.7rem; border:1px solid #d6d6d6; border-radius:8px; }
        .universe-btn { width:100%; border:none; background:#062abb; color:#fff; border-radius:10px; padding:.75rem; font-weight:700; cursor:pointer; }
        .universe-message { margin:8px 0; border-radius:8px; padding:.7rem; display:none; }
        .universe-message.error { background:#fff0f0; color:#b42318; display:block; }
        .universe-message.success { background:#ecfdf3; color:#027a48; display:block; }
        .universe-loading { margin:8px 0; display:none; color:#062abb; font-weight:600; }
        .universe-loading.show { display:block; }
      `;
      document.head.appendChild(style);
    }

    injectModal() {
      if (document.getElementById('universeAuthModal')) return;
      const wrapper = document.createElement('div');
      wrapper.innerHTML = `
      <div class="universe-auth-modal" id="universeAuthModal">
        <div class="universe-auth-content">
          <div class="universe-auth-header">
            <h2 class="universe-auth-title" id="universeAuthTitle">Вход</h2>
            <button class="universe-auth-close" type="button" onclick="universeAuth.closeModal()">×</button>
          </div>
          <div id="universeMessage" class="universe-message"></div>
          <div id="universeLoading" class="universe-loading"></div>
          <div class="universe-auth-tabs">
            <button class="universe-auth-tab active" type="button" data-tab="login" onclick="universeAuth.switchTab('login', event)">Вход</button>
            <button class="universe-auth-tab" type="button" data-tab="register" onclick="universeAuth.switchTab('register', event)">Регистрация</button>
          </div>
          <div id="universeLoginTab" class="universe-auth-tab-content active">
            <form onsubmit="universeAuth.handleLogin(event)">
              <div class="universe-form-group"><label>Email</label><input type="email" id="universeLoginEmail" required></div>
              <div class="universe-form-group"><label>Пароль</label><input type="password" id="universeLoginPassword" required></div>
              <button class="universe-btn" type="submit">Войти</button>
            </form>
          </div>
          <div id="universeRegisterTab" class="universe-auth-tab-content">
            <form onsubmit="universeAuth.handleRegister(event)">
              <div class="universe-form-group"><label>Полное имя</label><input type="text" id="universeRegisterName" required></div>
              <div class="universe-form-group"><label>Email</label><input type="email" id="universeRegisterEmail" required></div>
              <div class="universe-form-group"><label>Телефон (опционально)</label><input type="tel" id="universeRegisterPhone"></div>
              <div class="universe-form-group"><label>Пароль</label><input type="password" id="universeRegisterPassword" minlength="8" required></div>
              <div class="universe-form-group"><label>Подтверждение пароля</label><input type="password" id="universeRegisterPasswordConfirm" minlength="8" required></div>
              <button class="universe-btn" type="submit">Создать аккаунт</button>
            </form>
          </div>
        </div>
      </div>`;
      document.body.appendChild(wrapper.firstElementChild);
    }

    openModal() {
      const modal = document.getElementById('universeAuthModal');
      if (modal) modal.classList.add('active');
    }

    closeModal() {
      const modal = document.getElementById('universeAuthModal');
      if (modal) modal.classList.remove('active');
      this.clearMessages();
    }

    switchTab(tab, event) {
      document.querySelectorAll('.universe-auth-tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.universe-auth-tab-content').forEach((t) => t.classList.remove('active'));

      const tabButton = event?.target || document.querySelector(`.universe-auth-tab[data-tab="${tab}"]`);
      if (tabButton) tabButton.classList.add('active');

      const content = document.getElementById(`universe${tab.charAt(0).toUpperCase()}${tab.slice(1)}Tab`);
      if (content) content.classList.add('active');

      const title = document.getElementById('universeAuthTitle');
      if (title) title.textContent = tab === 'login' ? 'Вход' : 'Регистрация';
    }

    async handleLogin(e) {
      e.preventDefault();
      const email = (document.getElementById('universeLoginEmail')?.value || '').trim();
      const password = document.getElementById('universeLoginPassword')?.value || '';
      const result = await this.login(email, password);

      if (!result.success) {
        this.showError(result.error || 'Ошибка входа');
        return;
      }

      this.showSuccess('Вход выполнен');
      setTimeout(() => {
        this.closeModal();
        window.location.reload();
      }, 600);
    }

    async handleRegister(e) {
      e.preventDefault();
      const name = (document.getElementById('universeRegisterName')?.value || '').trim();
      const email = (document.getElementById('universeRegisterEmail')?.value || '').trim();
      const phone = (document.getElementById('universeRegisterPhone')?.value || '').trim();
      const password = document.getElementById('universeRegisterPassword')?.value || '';
      const confirm = document.getElementById('universeRegisterPasswordConfirm')?.value || '';

      if (password !== confirm) {
        this.showError('Пароли не совпадают');
        return;
      }

      const result = await this.register(name, email, phone, password);
      if (!result.success) {
        this.showError(result.error || 'Ошибка регистрации');
        return;
      }

      this.showSuccess('Регистрация успешна');
      setTimeout(() => {
        this.closeModal();
        window.location.reload();
      }, 700);
    }

    updateUI() {
      const loginBtn = document.getElementById('loginBtn');
      const userInfo = document.getElementById('userInfo');
      const userName = document.getElementById('userName');
      const userAvatar = document.getElementById('userAvatar');

      if (this.isAuthenticated()) {
        if (loginBtn) loginBtn.style.display = 'none';
        if (userInfo) userInfo.style.display = 'flex';
        if (userName) userName.textContent = this.currentUser.name || this.currentUser.email || 'Пользователь';
        if (userAvatar) {
          const initials = (this.currentUser.name || this.currentUser.email || 'U')
            .split(' ')
            .map((n) => n[0])
            .join('')
            .toUpperCase()
            .slice(0, 2);
          userAvatar.textContent = initials || 'U';
        }
      } else {
        if (loginBtn) loginBtn.style.display = 'flex';
        if (userInfo) userInfo.style.display = 'none';
      }
    }

    showError(message) {
      this.showMessage(message, 'error');
    }

    showSuccess(message) {
      this.showMessage(message, 'success');
    }

    showMessage(message, type) {
      const el = document.getElementById('universeMessage');
      if (!el) return;
      el.textContent = String(message || '');
      el.className = `universe-message ${type}`;
      el.style.display = 'block';
    }

    clearMessages() {
      const el = document.getElementById('universeMessage');
      if (!el) return;
      el.textContent = '';
      el.className = 'universe-message';
      el.style.display = 'none';
      this.hideLoading();
    }

    showLoading(message) {
      const el = document.getElementById('universeLoading');
      if (!el) return;
      el.textContent = String(message || 'Загрузка...');
      el.classList.add('show');
    }

    hideLoading() {
      const el = document.getElementById('universeLoading');
      if (!el) return;
      el.textContent = '';
      el.classList.remove('show');
    }

    forgotPassword() {
      this.showError('Функция восстановления будет добавлена позже.');
    }

    googleLogin() {
      window.location.href = `${this.baseURL}/google`;
    }
  }

  const universeAuth = new UniverseAuth();
  window.universeAuth = universeAuth;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = UniverseAuth;
  }
})();
