/**
 * Lê categorias, produtos e movimentações do Supabase no servidor (Vercel).
 * A chave de serviço fica só nas variáveis de ambiente da Vercel, nunca no navegador.
 * A leitura é paginada igual ao SupabaseRepository.fetch_snapshot do Streamlit (Drop/wedrop).
 */

const FETCH_PAGE_SIZE = 200; // Reduzido para evitar timeouts e melhorar performance
const REQUEST_TIMEOUT_MS = 15000; // 15 segundos por requisição
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000; // 1 segundo base para backoff

type Row = Record<string, unknown>;

interface ApiRequest {
  method?: string;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

async function fetchTableWithRetry(
  baseUrl: string,
  apiKey: string,
  table: string,
  orderKey: string
): Promise<Row[]> {
  const rows: Row[] = [];
  let attempt = 0;
  
  while (attempt < MAX_RETRIES) {
    try {
      const params = new URLSearchParams({
        select: '*',
        order: `${orderKey}.asc`,
        limit: String(FETCH_PAGE_SIZE),
        offset: String(rows.length),
      });
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      
      const response = await fetch(`${baseUrl}/rest/v1/${table}?${params}`, {
        headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new Error(`Supabase não respondeu a leitura de ${table} (HTTP ${response.status}): ${detail}`);
      }
      
      const page = (await response.json()) as Row[];
      if (page.length === 0) return rows;
      rows.push(...page);
      attempt = 0; // Reset retry count on success
      
    } catch (err) {
      attempt++;
      const isLastAttempt = attempt >= MAX_RETRIES;
      const errorMsg = err instanceof Error ? err.message : 'Erro desconhecido';
      
      // Se for timeout ou erro de rede, faz retry
      if (err instanceof Error && (err.name === 'AbortError' || errorMsg.includes('fetch'))) {
        if (!isLastAttempt) {
          const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1); // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }
      
      // Se for erro HTTP (não rede), não faz retry
      if (err instanceof Error && err.message.includes('HTTP')) {
        throw err;
      }
      
      if (isLastAttempt) {
        throw new Error(`Falha ao ler ${table} após ${MAX_RETRIES} tentativas: ${errorMsg}`);
      }
      
      // Retry para outros erros
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  return rows;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method && req.method !== 'GET') {
    res.status(405).json({ error: 'Método não permitido.' });
    return;
  }

  const baseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const apiKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '').trim();
  if (!baseUrl || !apiKey) {
    res.status(500).json({
      error:
        'Supabase não configurado. Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nas variáveis de ambiente da Vercel.',
    });
    return;
  }

  const startTime = Date.now();
  
  try {
    // Executa as requisições em paralelo com retry logic
    const [categories, products, stockEvents, stockSnapshots] = await Promise.all([
      fetchTableWithRetry(baseUrl, apiKey, 'wedrop_categories', 'category_url'),
      fetchTableWithRetry(baseUrl, apiKey, 'wedrop_products', 'product_id'),
      fetchTableWithRetry(baseUrl, apiKey, 'wedrop_stock_events', 'event_id'),
      fetchTableWithRetry(baseUrl, apiKey, 'wedrop_stock_snapshots', 'observation_id'),
    ]);
    
    const duration = Date.now() - startTime;
    console.log(`[snapshot] Dados carregados em ${duration}ms:`, {
      categories: categories.length,
      products: products.length,
      stockEvents: stockEvents.length,
      stockSnapshots: stockSnapshots.length,
    });
    
    // Mesmo tempo de vida do cache do Streamlit (5 min): a Vercel reaproveita a resposta nesse intervalo.
    // Aumentado para 10 minutos para reduzir carga no Supabase e evitar timeouts
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=120');
    res.status(200).json({
      categories,
      products,
      stock_events: stockEvents,
      stock_snapshots: stockSnapshots,
      fetched_at: new Date().toISOString(),
      duration_ms: duration,
    });
  } catch (err) {
    const duration = Date.now() - startTime;
    const message = err instanceof Error ? err.message : 'Erro desconhecido ao ler o Supabase.';
    console.error(`[snapshot] Erro após ${duration}ms:`, message);
    res.status(502).json({ error: message, duration_ms: duration });
  }
}
