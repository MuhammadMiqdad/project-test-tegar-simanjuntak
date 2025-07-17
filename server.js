const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true
}));

app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// Serve static files
app.use(express.static(path.join(__dirname, './')));

// Cache for API responses
const cache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Function to fix image URL
function fixImageUrl(imageObj) {
  if (!imageObj || !imageObj.url) return null;
  
  let url = imageObj.url;
  
  // If URL is relative, make it absolute
  if (url.startsWith('/')) {
    url = 'https://suitmedia-backend.suitdev.com' + url;
  }
  
  // If URL doesn't start with http/https, add https
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://suitmedia-backend.suitdev.com/' + url;
  }
  
  return {
    ...imageObj,
    url: url
  };
}

// API endpoint with enhanced error handling and caching
app.get('/api/ideas', async (req, res) => {
  try {
    const { page = 1, size = 10, sort = '-published_at' } = req.query;
    
    // Validate parameters
    const pageNumber = parseInt(page);
    const pageSize = parseInt(size);
    
    if (isNaN(pageNumber) || pageNumber < 1) {
      return res.status(400).json({ 
        error: 'Invalid page number',
        message: 'Page number must be a positive integer'
      });
    }
    
    if (isNaN(pageSize) || pageSize < 1 || pageSize > 100) {
      return res.status(400).json({ 
        error: 'Invalid page size',
        message: 'Page size must be between 1 and 100'
      });
    }
    
    if (!['published_at', '-published_at'].includes(sort)) {
      return res.status(400).json({ 
        error: 'Invalid sort parameter',
        message: 'Sort must be either "published_at" or "-published_at"'
      });
    }
    
    // Create cache key
    const cacheKey = `ideas_${pageNumber}_${pageSize}_${sort}`;
    
    // Check cache
    if (cache.has(cacheKey)) {
      const cachedData = cache.get(cacheKey);
      if (Date.now() - cachedData.timestamp < CACHE_DURATION) {
        console.log('Serving from cache:', cacheKey);
        return res.json(cachedData.data);
      } else {
        cache.delete(cacheKey);
      }
    }
    
    console.log(`Fetching ideas: page=${pageNumber}, size=${pageSize}, sort=${sort}`);
    
    // Make API request
    const response = await axios.get('https://suitmedia-backend.suitdev.com/api/ideas', {
      params: {
        'page[number]': pageNumber,
        'page[size]': pageSize,
        'append[]': ['small_image', 'medium_image'],
        sort: sort,
      },
      headers: { 
        'Accept': 'application/json',
        'User-Agent': 'Suitmedia-Ideas-App/1.0'
      },
      timeout: 10000 // 10 seconds timeout
    });
    
    // Validate response
    if (!response.data || !response.data.data) {
      throw new Error('Invalid response format from API');
    }
    
    // Process and clean data
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
    
    // Cache the response
    cache.set(cacheKey, {
      data: processedData,
      timestamp: Date.now()
    });
    
    // Clean old cache entries
    cleanCache();
    
    res.json(processedData);
    
  } catch (error) {
    console.error('Error fetching ideas:', error.message);
    
    let statusCode = 500;
    let errorMessage = 'Internal server error';
    
    if (error.code === 'ECONNABORTED') {
      statusCode = 504;
      errorMessage = 'Request timeout';
    } else if (error.response) {
      statusCode = error.response.status;
      errorMessage = error.response.data?.message || 'External API error';
    } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      statusCode = 503;
      errorMessage = 'Service unavailable';
    }
    
    res.status(statusCode).json({ 
      error: errorMessage,
      timestamp: new Date().toISOString(),
      path: req.path
    });
  }
});

// Clean old cache entries
function cleanCache() {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) {
      cache.delete(key);
    }
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    cache_size: cache.size
  });
});

// Handle 404 for API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    message: `The requested endpoint ${req.path} does not exist`
  });
});

// Serve index.html for root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: 'Something went wrong'
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  cache.clear();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  cache.clear();
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT,'0.0.0.0', () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`📱 Open your browser and navigate to: http://localhost:${PORT}`);
});

module.exports = app;
