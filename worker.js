// SONETO: Worker do Cloudflare.
// Roda apenas em /p/*, /a/* e /sitemap.xml (veja run_worker_first no wrangler.jsonc).
// Todo o resto do site continua sendo servido como arquivo estatico, sem custo.

const SUPABASE_URL = 'https://prmhbjubcdbxnuxxaxgy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_86pn0hWnXJOlUslDUDb2_w_YA5vPQud'; // chave publica
const SITE = 'https://soneto.me';

const COLORS = ['azul', 'manteiga', 'branco', 'rosa', 'menta', 'lilas', 'pessego'];
const FORM_NAMES = {
  livre: 'Versos livres', monostico: 'Monóstico', distico: 'Dístico', haicai: 'Haicai',
  quadra: 'Quadra', quintilha: 'Quintilha', sextilha: 'Sextilha', oitava: 'Oitava',
  decima: 'Décima', soneto: 'Soneto'
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_RE = /^[a-z0-9]{4,12}$/;
const SLUG_RE = /^[a-z0-9-]{2,60}$/;

const safeDec = s => { try { return decodeURIComponent(s); } catch (e) { return ''; } };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// consulta ao Supabase (com cache de 5 minutos na borda do Cloudflare)
async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Accept: 'application/json' },
    cf: { cacheEverything: true, cacheTtl: 300 }
  });
  if (!r.ok) throw new Error('supabase ' + r.status);
  return r.json();
}

async function fetchAll(path, pageSize = 1000, maxPages = 10) {
  const out = [];
  for (let i = 0; i < maxPages; i++) {
    const rows = await sbGet(`${path}&limit=${pageSize}&offset=${i * pageSize}`);
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

// pagina base do site (o index.html estatico)
function baseHtml(request, env) {
  return env.ASSETS.fetch(new Request(new URL('/', request.url).toString()));
}

function headExtras(m) {
  const tags = [
    m.url ? `<link rel="canonical" href="${esc(m.url)}">` : '',
    m.url ? `<meta property="og:url" content="${esc(m.url)}">` : '',
    `<meta name="twitter:title" content="${esc(m.ogTitle || m.title)}">`,
    `<meta name="twitter:description" content="${esc(m.description)}">`,
    `<meta name="twitter:image" content="${esc(m.image)}">`,
    m.noindex ? '<meta name="robots" content="noindex">' : ''
  ];
  return tags.filter(Boolean).join('\n');
}

// monta a resposta: o index.html com titulo, descricao, prévia e (opcional) o texto da pagina
function render(base, m, bodyHtml, status) {
  let rw = new HTMLRewriter()
    .on('title', { element(e) { e.setInnerContent(m.title); } })
    .on('meta[name="description"]', { element(e) { e.setAttribute('content', m.description); } })
    .on('meta[property="og:title"]', { element(e) { e.setAttribute('content', m.ogTitle || m.title); } })
    .on('meta[property="og:description"]', { element(e) { e.setAttribute('content', m.description); } })
    .on('meta[property="og:type"]', { element(e) { e.setAttribute('content', m.type || 'website'); } })
    .on('meta[property="og:image"]', { element(e) { e.setAttribute('content', m.image); } })
    .on('head', { element(e) { e.append(headExtras(m), { html: true }); } });
  if (bodyHtml) rw = rw.on('main#view', { element(e) { e.setInnerContent(bodyHtml, { html: true }); } });
  const res = rw.transform(base);
  const headers = new Headers(res.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', status === 200 ? 'public, max-age=300' : 'no-store');
  headers.delete('content-length');
  headers.delete('etag');
  return new Response(res.body, { status, headers });
}

const DEFAULT_IMAGE = `${SITE}/og/default.png`;
const NOT_FOUND = { title: 'Página não encontrada | Soneto', description: 'Esta página não existe no Soneto.', image: DEFAULT_IMAGE, noindex: true };

// ---------- /p/<codigo> ----------
async function poemPage(request, env, code) {
  const base = await baseHtml(request, env);
  let poem = null;
  try {
    const filter = UUID_RE.test(code) ? `id=eq.${code}` : (SHORT_RE.test(code) ? `short_id=eq.${code}` : null);
    if (filter) {
      const sel = 'id,short_id,title,body,form,color,sent_by_platform,author:authors(slug,name,kind),owner:profiles!user_id(username,display_name)';
      const rows = await sbGet(`poems?select=${sel}&${filter}&limit=1`);
      poem = rows[0] || null;
    } else {
      return render(base, NOT_FOUND, '', 404);
    }
  } catch (e) {
    return base; // se o banco falhar, entrega o site normal
  }
  if (!poem) return render(base, NOT_FOUND, '', 404);

  const lines = String(poem.body || '').split('\n').map(l => l.trim()).filter(Boolean);
  const excerpt = lines.slice(0, 3).join(' / ').slice(0, 180);
  const form = FORM_NAMES[poem.form] || 'Poema';
  const by = poem.author ? poem.author.name : (poem.owner ? (poem.owner.display_name || '@' + poem.owner.username) : '');
  const title = poem.title || 'Poema';
  const isAuthorPoem = !!poem.author;
  const m = {
    title: `${title}${by ? ' | ' + by : ''} | Soneto`,
    ogTitle: `${title}${by ? ', de ' + by : ''}`,
    description: `${form}${by ? ' · ' + by : ''}. ${excerpt}`,
    image: `${SITE}/og/${COLORS.includes(poem.color) ? poem.color : 'azul'}.png`,
    url: `${SITE}/p/${poem.short_id || poem.id}`,
    type: 'article',
    noindex: !isAuthorPoem // poemas da comunidade: previa nos links sim, indexacao no Google nao
  };
  const bodyHtml = isAuthorPoem
    ? `<article class="ssr"><h1>${esc(title)}</h1><p>por <a href="/a/${esc(poem.author.slug)}">${esc(poem.author.name)}</a></p><div class="ssr-body">${esc(poem.body)}</div></article>`
    : '';
  return render(base, m, bodyHtml, 200);
}

// ---------- /a/<slug> ----------
async function authorPage(request, env, slug) {
  const base = await baseHtml(request, env);
  if (!SLUG_RE.test(slug)) return render(base, NOT_FOUND, '', 404);
  let author = null, poems = [];
  try {
    const rows = await sbGet(`authors?select=id,slug,name,birth_year,death_year,bio,kind&slug=eq.${slug}&limit=1`);
    author = rows[0] || null;
    if (author) poems = await sbGet(`poems?select=short_id,title&author_id=eq.${author.id}&order=created_at.desc&limit=200`);
  } catch (e) {
    return base;
  }
  if (!author) return render(base, NOT_FOUND, '', 404);

  const years = (author.birth_year || '') + (author.death_year ? ' a ' + author.death_year : '');
  const m = {
    title: `${author.name} | Poemas | Soneto`,
    ogTitle: `${author.name}${years ? ' (' + years + ')' : ''}`,
    description: `${author.bio ? author.bio + ' ' : ''}Leia poemas de ${author.name} no Soneto.`.slice(0, 300),
    image: DEFAULT_IMAGE,
    url: `${SITE}/a/${author.slug}`,
    type: 'profile',
    noindex: false
  };
  const items = poems.map(p => `<li><a href="/p/${esc(p.short_id)}">${esc(p.title || 'Sem título')}</a></li>`).join('');
  const bodyHtml = `<article class="ssr"><h1>${esc(author.name)}</h1>`
    + (years ? `<p>${esc(years)}</p>` : '')
    + (author.bio ? `<p>${esc(author.bio)}</p>` : '')
    + (items ? `<ul>${items}</ul>` : '')
    + '</article>';
  return render(base, m, bodyHtml, 200);
}

// ---------- /sitemap.xml ----------
async function sitemap() {
  let authors = [], poems = [];
  try {
    authors = await fetchAll('authors?select=slug&order=slug');
    poems = await fetchAll('poems?select=short_id,created_at&author_id=not.is.null&order=created_at.desc');
  } catch (e) {
    return new Response('Erro ao gerar o sitemap', { status: 502 });
  }
  const urls = [`<url><loc>${SITE}/</loc></url>`]
    .concat(authors.map(a => `<url><loc>${SITE}/a/${esc(a.slug)}</loc></url>`))
    .concat(poems.map(p => `<url><loc>${SITE}/p/${esc(p.short_id)}</loc><lastmod>${esc(String(p.created_at).slice(0, 10))}</lastmod></url>`));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return env.ASSETS.fetch(request);
    const path = new URL(request.url).pathname;
    if (path === '/sitemap.xml') return sitemap();
    let m = path.match(/^\/p\/([^/]+)\/?$/);
    if (m) return poemPage(request, env, safeDec(m[1]));
    m = path.match(/^\/a\/([^/]+)\/?$/);
    if (m) return authorPage(request, env, safeDec(m[1]));
    return env.ASSETS.fetch(request);
  }
};
