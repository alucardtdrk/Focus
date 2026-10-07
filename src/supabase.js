export function createCloud({ url, key, storage = globalThis.localStorage, fetch: send = globalThis.fetch }) {
  const sessionKey = 'foco.auth.v1';
  let session = null;
  let refreshing = null;
  let authVersion = 0;
  function save(value) {
    session = value;
    if (value) storage.setItem(sessionKey, JSON.stringify(value));
    else storage.removeItem(sessionKey);
  }
  async function http(path, { method = 'GET', body, token, headers = {} } = {}) {
    let response;
    try {
      response = await send(url + path, {
        method, headers: { apikey: key, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000),
      });
    } catch { throw new Error('Sem conexão com o Supabase. Seus dados não foram enviados; tente novamente.'); }
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) {
      const error = new Error(data?.message || data?.msg || data?.error_description || 'Não foi possível concluir a operação no Supabase.');
      error.status = response.status;
      throw error;
    }
    return data;
  }
  async function token() {
    if (!session) throw new Error('Entre com sua conta de avaliador.');
    if (session.expires_at * 1000 > Date.now() + 60000) return session.access_token;
    if (!refreshing) refreshing = (async () => {
      const version = authVersion;
      try {
        const value = await http('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh_token } });
        if (version !== authVersion || !session) throw new Error('A sessão mudou. Entre novamente.');
        save({ ...value, expires_at: value.expires_at || Math.floor(Date.now() / 1000) + value.expires_in });
        return session.access_token;
      } catch (error) {
        if (error.status === 400 || error.status === 401) save(null);
        throw error;
      } finally { refreshing = null; }
    })();
    return refreshing;
  }
  return {
    get user() { return session?.user || null; },
    async restore() {
      const version = ++authVersion;
      try { session = JSON.parse(storage.getItem(sessionKey)); } catch { save(null); }
      if (!session?.access_token || !session?.refresh_token) { save(null); return null; }
      try {
        const user = await http('/auth/v1/user', { token: await token() });
        if (version !== authVersion || !session) throw new Error('A sessão mudou. Entre novamente.');
        save({ ...session, user });
        return user;
      } catch (error) {
        if (error.status === 401 || error.status === 403) { save(null); return null; }
        throw error;
      }
    },
    async signIn(email, password) {
      const version = ++authVersion;
      const value = await http('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
      if (version !== authVersion) throw new Error('A sessão mudou. Entre novamente.');
      save({ ...value, expires_at: value.expires_at || Math.floor(Date.now() / 1000) + value.expires_in });
      return session.user;
    },
    async signOut() {
      const access = session?.access_token;
      authVersion++;
      save(null);
      if (access) await http('/auth/v1/logout?scope=local', { method: 'POST', token: access });
    },
    async request(path, options = {}) { return http(path, { ...options, token: await token() }); },
    async rpc(name, body) { return http(`/rest/v1/rpc/${name}`, { method: 'POST', body }); },
  };
}
