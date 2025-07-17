const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// === Middleware === //
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://project-test-tegar-simanjuntak-production.up.railway.app'
  ],
  credentials: true
}));

app.use(express.json());

// Rate limiting to prevent abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100
});
app.use('/api/', limiter);

// Serve static files
app.use(express.static(path.join(__dirname, './')));

// === Cache Config === //
const cache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

function cleanCache() {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) {
      cache.delete(key);
    }
  }
}

// Fix relative image URLs
function fixImageUrl(imageObj) {
  if (!imageObj?.url) return null;
  let url = imageObj.url;

  if (url.startsWith('/')) {
    url = 'https://suitmedia-backend.suitdev.com' + url;
  } else if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://suitmedia-backend.suitdev.com/' + url;
  }

  return { ...imageObj, url };
}

// === API Endpoint === //
app.get('/api/ideas', async (req, res) => {
  try {
    const { page = 1, size = 10, sort = '-published_at' } = req.query;

    // Validate input
    const pageNumber = parseInt(page);
    const pageSize = parseInt(size);

    if (isNaN(pageNumber) || pageNumber < 1) {
      return res.status(400).json({ error: 'Invalid page number' });
    }
    if (isNaN(pageSize) || pageSize < 1 || pageSize > 100) {
      return res.status(400).json({ error: 'Invalid page size' });
    }
    if (!['published_at', '-published_at'].includes(sort)) {
      return res.status(400).json({ error: 'Invalid sort parameter' });
    }

    const cacheKey = `ideas_${pageNumber}_${pageSize}_${sort}`;
    const cached = cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      console.log('✔️ Served from cache:', cacheKey);
      return res.json(cached.data);
    }

    console.log(`📡 Fetching ideas: page=${pageNumber}, size=${pageSize}, sort=${sort}`);

    const response = await axios.get('https://suitmedia-backend.suitdev.com/api/ideas', {
      params: {
        'page[number]': pageNumber,
        'page[size]': pageSize,
        'append[]': ['small_image', 'medium_image'],
        sort
      },
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Suitmedia-Ideas-App/1.0'
      },
      timeout: 10000
    });

    if (!response.data?.data) throw new Error('Invalid response format from API');

    const processedData = {
      data: response.data.data.map(item => ({
        id: item.id,
        title: item.title || 'Untitled',
        published_at: item.published_at,
        small_image: fixImageUrl(item.small_image),
        medium_image: fixImageUrl(item.medium_image),
        created_at: item.created_at,
        updated_at: item.updated_at
      })),
      meta: {
        total: response.data.meta?.total || 0,
        current_page: response.data.meta?.current_page || pageNumber,
        per_page: response.data.meta?.per_page || pageSize,
        last_page: response.data.meta?.last_page || Math.ceil((response.data.meta?.total || 0) / pageSize),
        from: response.data.meta?.from || ((pageNumber - 1) * pageSize + 1),
        to: response.data.meta?.to || Math.min(pageNumber * pageSize, response.data.meta?.total || 0)
      }
    };

    cache.set(cacheKey, { data: processedData, timestamp: Date.now() });
    cleanCache();

    res.json(processedData);
  } catch (error) {
    console.error('❌ Error fetching ideas:', error.message);

    const statusCode = error.response?.status || 
                       (error.code === 'ECONNABORTED' ? 504 : 500);
    const errorMessage = error.response?.data?.message ||
                         (error.code === 'ECONNABORTED' ? 'Request timeout' :
                          error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' ? 'Service unavailable' :
                          'Internal server error');

    res.status(statusCode).json({
      error: errorMessage,
      timestamp: new Date().toISOString(),
      path: req.path
    });
  }
});

// === Proxy Middleware for External APIs (CORS bypass helper) === //
app.use('/proxy', createProxyMiddleware({
  target: 'https://suitmedia-api-production.up.railway.app',
  changeOrigin: true,
  pathRewrite: { '^/proxy': '' }
}));

// === Health check === //
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    cache_size: cache.size
  });
});

// === 404 API handler === //
app.use('/api/*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    message: `The requested endpoint ${req.path} does not exist`
  });
});

// === Serve frontend === //
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// === Global error handler === //
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: 'Something went wrong'
  });
});

// === Graceful shutdown === //
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received. Cleaning cache...');
  cache.clear();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('🛑 SIGINT received. Cleaning cache...');
  cache.clear();
  process.exit(0);
});

// === Start server === //
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

module.exports = app;
