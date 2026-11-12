// Notion settings page for DeepSeek Harness: account cards (email + workspace
// name + workspace logo) with add/switch/remove, and per-skill on/off toggles.
// The Host plugin runs a small loopback JSON API (localhost:53684) that this
// page calls directly, so the UI needs no typert Remote bridge.
window.__ModuleLoader__.load({
  id: 'dsh-notion-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const API = 'http://localhost:53684/api';
    const get = (path) => fetch(API + path).then((r) => r.json());
    const post = (path, body) => fetch(API + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    }).then((r) => r.json());

    // ---- i18n via the official client locale service; skills stay English ----
    const LOCALE_NS = 'dsh-notion-plugin';
    const DICT = {
      en: {
        connectedAccounts: 'Connected accounts',
        connectedHint: 'Notion workspaces connected to DeepSeek Harness. To finish setting up a workspace, ask the agent to run the Notion setup skill (once per workspace).',
        noWorkspace: 'No Notion workspace connected yet.',
        notionUser: 'Notion user',
        workspace: 'Workspace',
        remove: 'Remove',
        connectAccount: 'Connect account',
        connectAnother: 'Connect another account',
        openNotion: 'Open Notion',
        openNotionTitle: 'Open Notion; on the desktop app it opens in the right-side browser (sign in there once)',
        waiting: 'Waiting for you to finish in the browser…',
        retry: 'Retry',
        retryTitle: 'Reopen the connection page',
        setupChecking: 'Checking Notion setup…',
        setupDone: 'Notion setup: done',
        setupUnknown: 'Notion setup: unknown',
        setupNotDone: 'Notion setup: not done',
        setupClick: 'Click to set up this workspace',
        skills: 'Skills',
        skillsHint: 'Turn individual Notion skills on or off. Disabled skills stay hidden from the agent.',
        noSkills: 'No skills loaded.',
        serviceError: 'Cannot reach the Notion plugin service (localhost:53684). ',
        modalConnectedTitle: 'Connected',
        modalSetupTitle: 'Set up this workspace',
        modalConnectedText: '“{name}” is connected.',
        modalSetupLead: '“{name}” is connected successfully.',
        modalSetupBody: '“{name}” is connected but not set up yet. Copy the command below to finish setup; if you already set it up before, you can skip this.',
        modalSetupText: '“{name}” is not set up yet.',
        modalHint: 'If you already set Notion up before, you don’t need to do it again. Otherwise, copy the command, paste it into the message box, and press Enter.',
        copyCommand: 'Copy command',
        copied: 'Copied',
        finishedSetup: 'I’ve finished setup',
        close: 'Close',
        command: 'Use the Notion setup skill to initialize Notion for my current workspace: “{name}”.',
      },
      zh: {
        connectedAccounts: '已连接的账号',
        connectedHint: '已连接到 DeepSeek Harness 的 Notion 工作区。要完成某个工作区的初始化，请让 agent 运行 Notion 初始化技能（每个工作区一次）。',
        noWorkspace: '尚未连接任何 Notion 工作区。',
        notionUser: 'Notion 用户',
        workspace: '工作区',
        remove: '移除',
        connectAccount: '连接账号',
        connectAnother: '连接其他账号',
        openNotion: '打开 Notion',
        openNotionTitle: '打开 Notion；桌面端会在右侧边栏浏览器中打开（在那里登录一次）',
        waiting: '正在等待你在浏览器中完成操作…',
        retry: '重试',
        retryTitle: '重新打开连接页面',
        setupChecking: '正在检查 Notion 配置…',
        setupDone: 'Notion 配置：已完成',
        setupUnknown: 'Notion 配置：未知',
        setupNotDone: 'Notion 配置：未完成',
        setupClick: '点击初始化此工作区',
        skills: '技能',
        skillsHint: '单独开启或关闭各个 Notion 技能。已关闭的技能不会显示给 agent。',
        noSkills: '尚未加载任何技能。',
        serviceError: '无法连接 Notion 插件服务（localhost:53684）。',
        modalConnectedTitle: '已连接',
        modalSetupTitle: '初始化此工作区',
        modalConnectedText: '“{name}” 已连接。',
        modalSetupLead: '“{name}” 已成功连接。',
        modalSetupBody: '“{name}” 已连接，但还没有完成初始化。复制下面的命令即可完成配置；如果你之前已经完成过，可以跳过。',
        modalSetupText: '“{name}” 尚未初始化。',
        modalHint: '如果你之前已经完成过配置，则无需再次配置。否则，请复制下面的命令，粘贴到输入框并回车。',
        copyCommand: '拷贝命令',
        copied: '已拷贝',
        finishedSetup: '我已完成配置',
        close: '关闭',
        command: '请使用 Notion 初始化技能，为我的当前工作区完成初始化：{name}。',
      },
    };
    // `_t` is the locale-bound translate function set in apply(); falls back to EN.
    let _ctx = null;
    let _t = (key) => (DICT.en[key] !== undefined ? DICT.en[key] : key);
    const _localeListeners = new Set();
    const useLocale = () => {
      const [, bump] = React.useState(0);
      React.useEffect(() => {
        const fn = () => bump((n) => n + 1);
        _localeListeners.add(fn);
        return () => { _localeListeners.delete(fn); };
      }, []);
      return null;
    };
    const t = (key, vars) => {
      let s = _t(key);
      if (s === undefined || s === key) s = (DICT.en[key] !== undefined ? DICT.en[key] : key);
      if (vars) s = String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
      return s;
    };

    const CSS = `
.notion-settings{display:flex;flex-direction:column;gap:20px;color:var(--dsw-alias-label-primary,light-dark(#0f1115,#f9fafb));font-size:13px;line-height:20px}
.notion-settings h3{margin:0 0 4px;font-size:14px;font-weight:600}
.notion-settings .subtle{color:var(--dsw-alias-label-secondary,light-dark(#61666b,#cfd3d6));font-size:12px;margin:0 0 12px}
.notion-card{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2,light-dark(#0000001a,#ffffff1f));background:var(--dsw-alias-bg-module-platform,light-dark(#fff,#353638))}
.notion-card+.notion-card{margin-top:8px}
.notion-logo{flex:none;width:36px;height:36px;border-radius:8px;overflow:hidden;display:grid;place-items:center;background:var(--dsw-alias-interactive-bg-hover,light-dark(#2631480f,#ffffff14));font-weight:700}
.notion-logo img{width:100%;height:100%;object-fit:cover}
.notion-card-main{flex:1;min-width:0}
.notion-card-email{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.notion-card-ws{color:var(--dsw-alias-label-secondary,light-dark(#61666b,#cfd3d6));font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.notion-badge{font-size:11px;padding:1px 8px;border-radius:99px;background:var(--dsw-alias-interactive-bg-active,light-dark(#2631481a,#ffffff24))}
.notion-btn{border:1px solid var(--dsw-alias-border-l2,light-dark(#0000001a,#ffffff1f));background:transparent;color:inherit;border-radius:8px;padding:5px 10px;font:inherit;font-size:12px;cursor:pointer}
.notion-btn:hover{background:var(--dsw-alias-interactive-bg-hover,light-dark(#2631480f,#ffffff14))}
.notion-btn.primary{background:var(--dsw-alias-brand-primary,light-dark(#0f1115,#f9fafb));color:var(--dsw-alias-label-primary-foreground,light-dark(#fff,#0f1115));border:0}
.notion-btn.danger{color:#d4384a;border-color:transparent}
.notion-skill{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l1,light-dark(#0000000a,#ffffff0f))}
.notion-skill:last-child{border-bottom:0}
.notion-skill-main{flex:1;min-width:0}
.notion-skill-title{font-weight:500}
.notion-skill-desc{color:var(--dsw-alias-label-secondary,light-dark(#61666b,#cfd3d6));font-size:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.notion-switch{appearance:none;position:relative;flex:none;width:36px;height:20px;margin:0;border:0;border-radius:99px;background:var(--dsw-alias-border-l2,light-dark(#0000001a,#ffffff1f));cursor:pointer;transition:background .15s}
.notion-switch::before{content:"";position:absolute;left:2px;top:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s}
.notion-switch:checked{background:var(--dsw-alias-brand-primary,light-dark(#0f1115,#f9fafb))}
.notion-switch:checked::before{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground,light-dark(#fff,#0f1115))}
.notion-empty{color:var(--dsw-alias-label-secondary,light-dark(#61666b,#cfd3d6));padding:8px 0}
.notion-err{color:#d4384a;font-size:12px}
.notion-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.38);display:flex;align-items:center;justify-content:center;z-index:9999}
.notion-modal{background:var(--dsw-alias-bg-base,light-dark(#fff,#1c1d20));color:var(--dsw-alias-label-primary,light-dark(#0f1115,#f9fafb));border-radius:18px;padding:26px 20px 20px;width:min(88vw,300px);box-shadow:0 16px 48px rgba(0,0,0,.3);display:flex;flex-direction:column;align-items:stretch;text-align:left;gap:10px}
.notion-modal-icon{width:52px;height:52px;display:block;margin:0 auto 2px}
.notion-modal h3{margin:0;font-size:18px;font-weight:600}
.notion-modal-text{margin:0;font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary,light-dark(#0f1115,#f9fafb))}
.notion-modal-hint{margin:0;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary,light-dark(#61666b,#cfd3d6))}
.notion-modal-ta{width:100%;box-sizing:border-box;font:12px/18px ui-monospace,Menlo,monospace;color:inherit;background:var(--dsw-alias-bg-layer-1,light-dark(#f3f4f5,#232427));border:.5px solid var(--dsw-alias-border-l2,#ddd);border-radius:8px;padding:8px;resize:vertical;text-align:left}
.notion-modal-actions{display:flex;flex-direction:column;gap:10px;width:100%;margin-top:8px}
.notion-modal-btn{display:block;width:100%;box-sizing:border-box;height:44px;border-radius:9999px;font-size:14px;font-weight:500;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,light-dark(#dcdcdc,#3a3b3e));background:var(--dsw-alias-bg-layer-1,light-dark(#f3f4f5,#232427));color:inherit}
.notion-modal-btn.primary{background:#000;border-color:#000;color:#fff}
.notion-modal-btn.primary:hover{opacity:.9}
.notion-link-btn{background:none;border:0;padding:0;margin:0;color:var(--dsw-alias-label-secondary,light-dark(#61666b,#cfd3d6));font:inherit;font-size:12px;text-decoration:underline;cursor:pointer}
.notion-link-btn:hover{color:var(--dsw-alias-label-primary,light-dark(#0f1115,#f9fafb))}
.notion-setup-link{display:inline-block;margin-top:2px;padding:0;background:none;border:0;font-size:11px;color:#d97706;text-decoration:underline;cursor:pointer;text-align:left}
.notion-setup-link:hover{color:#b45309}
`;

    // Inline check-mark icon (no emoji).
    const CHECK_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none">' +
      '<circle cx="24" cy="24" r="22" fill="#22c55e"/>' +
      '<path d="M15 24.5l6 6 12-13" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>');
    // Neutral "info / pending" icon (amber) for the not-yet-set-up state.
    const INFO_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none">' +
      '<circle cx="24" cy="24" r="22" fill="#f59e0b"/>' +
      '<path d="M24 14v13" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/>' +
      '<circle cx="24" cy="33" r="2.2" fill="#fff"/></svg>');

    // Modal shown right after a workspace connects: confirms success and offers
    // to copy the setup command. Falls back to a selectable textarea when the
    // clipboard API is unavailable.
    function SuccessModal({ account, mode, onClose, onMarkDone }) {
      const [copied, setCopied] = React.useState(false);
      const [fallback, setFallback] = React.useState(false);
      const taRef = React.useRef(null);
      useLocale();
      const setupMode = mode === 'setup';
      const name = (account && (account.workspaceName || account.workspaceId)) || 'this workspace';
      // English command that names the workspace being set up.
      const command = t('command', { name });
      const copy = async () => {
        try {
          if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            return;
          }
        } catch (e) { /* fall through */ }
        setFallback(true);
        setTimeout(() => { try { taRef.current && taRef.current.select(); } catch (e) {} }, 0);
      };
      return h('div', { className: 'notion-modal-backdrop', onClick: onClose },
        h('div', { className: 'notion-modal', onClick: (e) => e.stopPropagation() },
          h('img', { className: 'notion-modal-icon', src: CHECK_SVG, alt: '' }),
          h('h3', null, t('modalConnectedTitle')),
          setupMode
            ? h('p', { className: 'notion-modal-text' }, t('modalSetupBody'))
            : h('p', { className: 'notion-modal-text' }, t('modalConnectedText', { name })),
          setupMode ? null : h('p', { className: 'notion-modal-hint' }, t('modalHint')),
          fallback
            ? h('textarea', {
                ref: taRef, className: 'notion-modal-ta', readOnly: true, value: command,
                onFocus: (e) => { try { e.target.select(); } catch (er) {} }, rows: 3,
              })
            : null,
          h('div', { className: 'notion-modal-actions' },
            h('button', { className: 'notion-modal-btn primary', onClick: copy }, copied ? t('copied') : t('copyCommand')),
            setupMode && onMarkDone
              ? h('button', { className: 'notion-modal-btn', onClick: onMarkDone }, t('finishedSetup'))
              : null,
            h('button', { className: 'notion-modal-btn', onClick: onClose }, t('close')))));
    }

    function SettingsPage() {
      useLocale();
      const [accounts, setAccounts] = React.useState({ accounts: [], activeId: undefined });
      const [skills, setSkills] = React.useState([]);
      const [setup, setSetup] = React.useState({}); // accountId -> {initialized}
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [waiting, setWaiting] = React.useState(false);
      const [successModal, setSuccessModal] = React.useState(null); // newly connected account, shows modal

      const reload = React.useCallback(async () => {
        try {
          const [a, s] = await Promise.all([get('/accounts'), get('/skills')]);
          setAccounts(a && a.accounts ? a : { accounts: [], activeId: undefined });
          setSkills((s && s.skills) || []);
          setError('');
          // Probe each workspace's Notion setup state (read from the workspace,
          // not local state, so it survives disconnect/reconnect). Best-effort.
          const list = (a && a.accounts) || [];
          list.forEach((acc) => {
            get('/setup-status?id=' + encodeURIComponent(acc.id))
              .then((st) => setSetup((prev) => ({ ...prev, [acc.id]: st })))
              .catch(() => {});
          });
        } catch (e) { setError(t('serviceError') + (e && e.message ? e.message : '')); }
      }, []);

      React.useEffect(() => { reload(); }, [reload]);

      // Human-readable setup state for one account card.
      const setupLabel = (id) => {
        const st = setup[id];
        if (!st) return t('setupChecking');
        if (st.initialized) return t('setupDone');
        if (st.reason === 'no-token' || st.reason === 'probe-failed') return t('setupUnknown');
        return t('setupNotDone');
      };

      // Poll while waiting for the browser authorization to complete in the other
      // tab; stop as soon as the account count grows.
      React.useEffect(() => {
        if (!waiting) return undefined;
        const target = accounts.accounts.length;
        let stop = false;
        const tick = async () => {
          if (stop) return;
          try {
            const a = await get('/accounts');
            if (a && a.accounts && a.accounts.length > target) {
              setAccounts(a);
              setWaiting(false);
              // Newly connected account = the one not present before; show the
              // success modal offering to copy the setup command.
              const prevIds = new Set(accounts.accounts.map((x) => x.id));
              const fresh = a.accounts.find((x) => !prevIds.has(x.id)) || a.accounts[a.accounts.length - 1];
              if (fresh) setSuccessModal({ account: fresh, mode: 'connected' });
              return;
            }
          } catch { /* keep polling */ }
          if (!stop) setTimeout(tick, 2000);
        };
        const id = setTimeout(tick, 2000);
        return () => { stop = true; clearTimeout(id); };
      }, [waiting, accounts.accounts.length]);

      const run = async (fn) => {
        setBusy(true);
        try { await fn(); await reload(); }
        catch (e) { setError(String(e && e.message ? e.message : e)); }
        finally { setBusy(false); }
      };

      const connect = async () => {
        try {
          const r = await get('/auth-url');
          if (r && r.url && typeof window !== 'undefined') {
            window.open(r.url, '_blank', 'noopener');
            setWaiting(true);
          }
        } catch (e) { setError(String(e && e.message ? e.message : e)); }
      };

      // A workspace icon may be an absolute image URL, a Notion built-in icon
      // path (/icons/…), or a glyph/emoji. Resolve the first two to an image src.
      const iconSrc = (icon) => {
        if (typeof icon !== 'string' || !icon) return '';
        if (/^https?:\/\//i.test(icon)) return icon;
        if (icon.startsWith('/icons/') || icon.startsWith('/images/')) return 'https://www.notion.so' + icon;
        return '';
      };

      return h('div', { className: 'notion-settings' },
        h('style', null, CSS),
        h('section', null,
          h('h3', null, t('connectedAccounts')),
          h('p', { className: 'subtle' }, t('connectedHint')),
          accounts.accounts.length === 0
            ? h('div', { className: 'notion-empty' }, t('noWorkspace'))
            : accounts.accounts.map((a) => h('div', { className: 'notion-card', key: a.id },
                h('div', { className: 'notion-logo' },
                  iconSrc(a.workspaceIcon)
                    ? h('img', { src: iconSrc(a.workspaceIcon), alt: '' })
                    : h('span', null, (typeof a.workspaceIcon === 'string' && a.workspaceIcon && !a.workspaceIcon.startsWith('/')) ? a.workspaceIcon : (a.workspaceName || 'N').slice(0, 1).toUpperCase())),
                h('div', { className: 'notion-card-main' },
                  h('div', { className: 'notion-card-email' }, a.email || t('notionUser')),
                  h('div', { className: 'notion-card-ws' }, a.workspaceName || a.workspaceId || t('workspace')),
                  (function () {
                    const st = setup[a.id];
                    const notDone = st && !st.initialized && st.reason !== 'no-token' && st.reason !== 'probe-failed';
                    const label = setupLabel(a.id);
                    return notDone
                      ? h('button', { className: 'notion-setup-link', disabled: busy, onClick: () => setSuccessModal({ account: a, mode: 'setup' }),
                          title: t('setupClick') }, label)
                      : h('div', { className: 'subtle', style: { marginTop: 2, fontSize: 11 } }, label);
                  })()),
                h('button', { className: 'notion-btn danger', disabled: busy, onClick: () => run(() => post('/remove', { id: a.id })) }, t('remove')))),
          h('div', { style: { marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('button', { className: 'notion-btn primary', disabled: busy || waiting, onClick: connect },
              accounts.accounts.length === 0 ? t('connectAccount') : t('connectAnother')),
            accounts.accounts.length > 0 ? h('button', {
              className: 'notion-btn', disabled: busy,
              title: t('openNotionTitle'),
              onClick: () => {
                const url = 'https://www.notion.so';
                try {
                  const sr = _ctx && _ctx.get('sidebarRight');
                  if (sr && typeof sr.openTab === 'function') { sr.openTab('browser', { params: { url } }); return; }
                } catch (e) { /* fall through */ }
                try { window.open(url, '_blank', 'noopener'); } catch (e) { /* popup blocked */ }
              },
            }, t('openNotion')) : null,
            waiting ? h('span', { className: 'subtle', style: { margin: 0 } },
              t('waiting') + ' ',
              h('button', { className: 'notion-link-btn', onClick: connect, title: t('retryTitle') }, t('retry'))) : null)),
        h('section', null,
          h('h3', null, t('skills')),
          h('p', { className: 'subtle' }, t('skillsHint')),
          skills.length === 0 ? h('div', { className: 'notion-empty' }, t('noSkills'))
            : skills.map((s) => h('div', { className: 'notion-skill', key: s.name },
                h('div', { className: 'notion-skill-main' },
                  h('div', { className: 'notion-skill-title' }, s.title || s.name),
                  h('div', { className: 'notion-skill-desc' }, s.description || '')),
                h('input', {
                  type: 'checkbox', className: 'notion-switch', checked: !!s.enabled, disabled: busy,
                  'aria-label': `Enable ${s.title || s.name}`,
                  onChange: (ev) => run(() => post('/skill', { name: s.name, enabled: ev.target.checked })),
                })))),
        error ? h('div', { className: 'notion-err' }, error) : null,
        successModal ? h(SuccessModal, {
          account: successModal.account,
          mode: successModal.mode,
          onClose: () => setSuccessModal(null),
          onMarkDone: async () => {
            const id = successModal.account && successModal.account.id;
            try { await post('/setup-done', { id }); } catch (e) { /* ignore */ }
            setSuccessModal(null);
            setSetup((prev) => ({ ...prev, [id]: { initialized: true } }));
          },
        }) : null
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        _ctx = ctx;
        // Locale: register our dictionaries and bind a translate function, using
        // the official client locale service (inject: ['locale']).
        try {
          ctx.locale.register(LOCALE_NS, DICT);
          _t = ctx.locale.bind(LOCALE_NS);
          _localeListeners.clear();
          if (typeof ctx.locale.subscribe === 'function') {
            ctx.locale.subscribe(() => { _localeListeners.forEach((fn) => { try { fn(); } catch (e) {} }); });
          }
        } catch (e) { /* locale service unavailable; keep EN fallback */ }
        // Notion "N" mark used for the settings nav icon.
        const NOTION_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 335 350" width="100%" height="100%" fill="none"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M214.701 0.796296L21.056 15.0565C5.44153 16.4088 0 26.5954 0 38.8077V250.61C0 260.126 3.3919 268.259 11.5487 279.13L57.0693 338.19C64.5464 347.701 71.3416 349.735 85.6192 349.054L310.498 335.475C329.518 334.124 334.958 325.292 334.958 310.358V72.0749C334.958 64.3554 331.904 62.1254 322.899 55.5518C322.404 55.1901 321.891 54.8153 321.359 54.4257L259.545 10.9802C244.599 0.122938 238.481 -1.24326 214.701 0.796296ZM90.718 68.1664C72.3581 69.4062 68.1862 69.6879 57.7599 61.2177L31.2457 40.1737C28.5415 37.4525 29.8978 34.0579 36.6871 33.3847L222.855 19.8061C238.478 18.4455 246.629 23.8852 252.747 28.635L284.678 51.7183C286.038 52.3944 289.429 56.4624 285.351 56.4624L93.0882 68.0071C92.2729 68.0614 91.4837 68.1147 90.719 68.1664L90.718 68.1664ZM69.3031 308.318V106.024C69.3031 97.2006 72.021 93.1245 80.1694 92.4398L300.977 79.5458C308.466 78.867 311.857 83.6223 311.857 92.4398V293.376C311.857 302.208 310.495 309.686 298.261 310.358L86.9643 322.584C74.7361 323.257 69.3031 319.19 69.3031 308.318ZM277.894 116.876C279.249 122.992 277.894 129.102 271.768 129.789L261.586 131.817V281.164C252.747 285.915 244.596 288.631 237.804 288.631C226.929 288.631 224.206 285.234 216.06 275.056L149.467 170.513V271.662L170.539 276.417C170.539 276.417 170.539 288.631 153.538 288.631L106.67 291.349C105.308 288.631 106.67 281.848 111.424 280.488L123.654 277.099V143.362L106.672 142.001C105.311 135.886 108.703 127.068 118.221 126.383L168.501 122.994L237.804 228.898V135.212L220.135 133.184C218.778 125.707 224.206 120.278 231.001 119.605L277.894 116.876Z"/></svg>';
        function NotionIcon(props) {
          const s = (props && props.size) || 20;
          return h('span', { style: { display: 'inline-flex', width: s, height: s }, 'aria-hidden': true, dangerouslySetInnerHTML: { __html: NOTION_SVG } });
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'notion', order: 25, locale: LOCALE_NS, label: 'Notion',
        }, SettingsPage));
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon', id: 'notion', order: 25,
        }, NotionIcon));

        // Headless watcher: auto-open Notion pages requested by the host's
        // notion_open_page tool. Opens the URL in DSH's right-panel Browser tab
        // via ctx.sidebarRight.openTab('browser', { params: { url } }), falling
        // back to a new browser tab if that API is unavailable.
        function OpenWatcher() {
          const seen = React.useRef(0);
          React.useEffect(() => {
            let stop = false;
            const tick = async () => {
              if (stop) return;
              try {
                const r = await get('/last-open');
                if (r && r.url && r.at && r.at !== seen.current) {
                  seen.current = r.at;
                  // Desktop: open in DSH's right-sidebar Browser tab. Web has no
                  // sidebar browser, so we do NOT auto-open a window here — the
                  // tool result already carries a clickable link for the user.
                  try {
                    const sr = _ctx && _ctx.get('sidebarRight');
                    if (sr && typeof sr.openTab === 'function') sr.openTab('browser', { params: { url: r.url } });
                  } catch (e) { /* no sidebar browser (web): leave it to the link */ }
                  fetch(API + '/last-open?ack=' + r.at).catch(() => {});
                }
              } catch (e) { /* ignore */ }
              if (!stop) setTimeout(tick, 1500);
            };
            tick();
            return () => { stop = true; };
          }, []);
          return null;
        }
        // Mount the watcher once in a global list slot (renders nothing).
        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay', id: 'notion-open-watcher', order: 1,
        }, OpenWatcher));
      },
    };
  },
});
