const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Add timeout middleware
app.use((req, res, next) => {
  req.setTimeout(10000, () => {
    res.status(503).json({ error: 'Request timeout' });
  });
  next();
});

// Check if DATABASE_URL exists
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable is missing!');
  console.log('Please set DATABASE_URL in your .env file');
}

// Optimized PostgreSQL connection
const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

if (process.env.NODE_ENV === 'production') {
  poolConfig.ssl = {
    rejectUnauthorized: false
  };
}

const pool = new Pool(poolConfig);

// Database connection events
pool.on('connect', () => {
  console.log('✅ Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL pool error:', err);
});

// Response cache
const cache = new Map();

// Test database connection route
app.get('/api/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() as current_time');
    res.json({ 
      message: '✅ Database connection successful',
      currentTime: result.rows[0].current_time,
      database: process.env.DATABASE_URL ? 'Connected' : 'No connection string'
    });
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    res.status(500).json({ 
      error: 'Database connection failed',
      details: error.message,
      connectionString: process.env.DATABASE_URL ? 'Present but invalid' : 'Missing'
    });
  }
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    const queryTime = Date.now() - start;
    
    res.json({
      status: 'healthy',
      database: 'connected',
      responseTime: `${queryTime}ms`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      database: 'disconnected',
      error: error.message
    });
  }
});

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Auth middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// Optimized helper function to shift display orders
async function shiftDisplayOrders(table, newOrder, currentOrder = null, excludeId = null) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        if (currentOrder !== null && currentOrder !== undefined) {
            await client.query(
                `UPDATE ${table} SET display_order = display_order - 1 WHERE display_order > $1 AND (id != $2 OR $2 IS NULL)`,
                [currentOrder, excludeId]
            );
        }

        await client.query(
            `UPDATE ${table} SET display_order = display_order + 1 WHERE display_order >= $1 AND (id != $2 OR $2 IS NULL)`,
            [newOrder, excludeId]
        );

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Error shifting display orders for ${table}:`, error);
        throw error;
    } finally {
        client.release();
    }
}

// Clear cache helper
function clearCache(key) {
    cache.delete(key);
}

// Routes

// Authentication
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    if (password === 'admin123') {
      const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
      res.json({ token, user: { id: user.id, username: user.username } });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Sectors routes with caching
app.get('/api/sectors', async (req, res) => {
  const cacheKey = 'sectors';
  const cacheTime = 15000; // 15 seconds
  
  if (cache.has(cacheKey)) {
    const { data, timestamp } = cache.get(cacheKey);
    if (Date.now() - timestamp < cacheTime) {
      return res.json(data);
    }
  }

  try {
    const result = await pool.query('SELECT * FROM sectors WHERE is_active = true ORDER BY display_order');
    cache.set(cacheKey, { data: result.rows, timestamp: Date.now() });
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching sectors:', error);
    res.json([]);
  }
});

app.post('/api/sectors', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { title, description, image_url, link_url, display_order } = req.body;
    const newOrder = display_order || 1;

    await shiftDisplayOrders('sectors', newOrder, null, null);

    const result = await client.query(
      'INSERT INTO sectors (title, description, image_url, link_url, display_order, is_active) VALUES ($1, $2, $3, $4, $5, true) RETURNING *',
      [title, description, image_url, link_url, newOrder]
    );

    await client.query('COMMIT');
    clearCache('sectors');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating sector:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.put('/api/sectors/:id', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const { title, description, image_url, link_url, display_order, is_active } = req.body;

    const currentResult = await client.query('SELECT display_order FROM sectors WHERE id = $1', [id]);
    const currentOrder = currentResult.rows[0]?.display_order;

    await shiftDisplayOrders('sectors', display_order, currentOrder, id);

    const activeStatus = is_active !== undefined ? is_active : true;
    
    const result = await client.query(
      'UPDATE sectors SET title = $1, description = $2, image_url = $3, link_url = $4, display_order = $5, is_active = $6, updated_at = CURRENT_TIMESTAMP WHERE id = $7 RETURNING *',
      [title, description, image_url, link_url, display_order, activeStatus, id]
    );

    await client.query('COMMIT');
    clearCache('sectors');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating sector:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.delete('/api/sectors/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM sectors WHERE id = $1', [id]);
    clearCache('sectors');
    res.json({ message: 'Sector deleted successfully' });
  } catch (error) {
    console.error('Error deleting sector:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Commitments routes with caching
app.get('/api/commitments', async (req, res) => {
  const cacheKey = 'commitments';
  const cacheTime = 15000;
  
  if (cache.has(cacheKey)) {
    const { data, timestamp } = cache.get(cacheKey);
    if (Date.now() - timestamp < cacheTime) {
      return res.json(data);
    }
  }

  try {
    const result = await pool.query('SELECT * FROM commitments WHERE is_active = true ORDER BY display_order');
    cache.set(cacheKey, { data: result.rows, timestamp: Date.now() });
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching commitments:', error);
    res.json([]);
  }
});

app.post('/api/commitments', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { title, description, image_url, display_order } = req.body;
    const newOrder = display_order || 1;

    await shiftDisplayOrders('commitments', newOrder, null, null);

    const result = await client.query(
      'INSERT INTO commitments (title, description, image_url, display_order, is_active) VALUES ($1, $2, $3, $4, true) RETURNING *',
      [title, description, image_url, newOrder]
    );

    await client.query('COMMIT');
    clearCache('commitments');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating commitment:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.put('/api/commitments/:id', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const { title, description, image_url, display_order, is_active } = req.body;

    const currentResult = await client.query('SELECT display_order FROM commitments WHERE id = $1', [id]);
    const currentOrder = currentResult.rows[0]?.display_order;

    await shiftDisplayOrders('commitments', display_order, currentOrder, id);

    const activeStatus = is_active !== undefined ? is_active : true;

    const result = await client.query(
      'UPDATE commitments SET title = $1, description = $2, image_url = $3, display_order = $4, is_active = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6 RETURNING *',
      [title, description, image_url, display_order, activeStatus, id]
    );

    await client.query('COMMIT');
    clearCache('commitments');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating commitment:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Leadership routes with caching
app.get('/api/leadership', async (req, res) => {
  const cacheKey = 'leadership';
  const cacheTime = 15000;
  
  if (cache.has(cacheKey)) {
    const { data, timestamp } = cache.get(cacheKey);
    if (Date.now() - timestamp < cacheTime) {
      return res.json(data);
    }
  }

  try {
    const result = await pool.query('SELECT * FROM leadership WHERE is_active = true ORDER BY display_order');
    cache.set(cacheKey, { data: result.rows, timestamp: Date.now() });
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching leadership:', error);
    res.json([]);
  }
});

app.post('/api/leadership', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { name, role, description, more_content, display_order } = req.body;
    const newOrder = display_order || 1;

    await shiftDisplayOrders('leadership', newOrder, null, null);

    const result = await client.query(
      'INSERT INTO leadership (name, role, description, more_content, display_order, is_active) VALUES ($1, $2, $3, $4, $5, true) RETURNING *',
      [name, role, description, more_content, newOrder]
    );

    await client.query('COMMIT');
    clearCache('leadership');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating leadership:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.put('/api/leadership/:id', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const { name, role, description, more_content, display_order, is_active } = req.body;

    const currentResult = await client.query('SELECT display_order FROM leadership WHERE id = $1', [id]);
    const currentOrder = currentResult.rows[0]?.display_order;

    await shiftDisplayOrders('leadership', display_order, currentOrder, id);

    const activeStatus = is_active !== undefined ? is_active : true;

    const result = await client.query(
      'UPDATE leadership SET name = $1, role = $2, description = $3, more_content = $4, display_order = $5, is_active = $6, updated_at = CURRENT_TIMESTAMP WHERE id = $7 RETURNING *',
      [name, role, description, more_content, display_order, activeStatus, id]
    );

    await client.query('COMMIT');
    clearCache('leadership');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating leadership:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Get single item routes
app.get('/api/sectors/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM sectors WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Sector not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching sector:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/commitments/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM commitments WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Commitment not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching commitment:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/leadership/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM leadership WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Leadership member not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching leadership member:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/minerals/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM minerals WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Mineral not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching mineral:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/agricultural-products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM agricultural_products WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Agricultural product not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching agricultural product:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Mining vision routes
app.get('/api/mining-vision', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM mining_vision ORDER BY id DESC LIMIT 1');
    res.json(result.rows[0] || {});
  } catch (error) {
    console.error('Error fetching mining vision:', error);
    res.json({});
  }
});

app.post('/api/mining-vision', authenticateToken, async (req, res) => {
  try {
    const { title, content, image_url } = req.body;
    const result = await pool.query(
      'INSERT INTO mining_vision (title, content, image_url) VALUES ($1, $2, $3) RETURNING *',
      [title, content, image_url]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating mining vision:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/mining-vision/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, image_url } = req.body;
    const result = await pool.query(
      'UPDATE mining_vision SET title = $1, content = $2, image_url = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *',
      [title, content, image_url, id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating mining vision:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Minerals routes with caching
app.get('/api/minerals', async (req, res) => {
  const cacheKey = 'minerals';
  const cacheTime = 15000;
  
  if (cache.has(cacheKey)) {
    const { data, timestamp } = cache.get(cacheKey);
    if (Date.now() - timestamp < cacheTime) {
      return res.json(data);
    }
  }

  try {
    const result = await pool.query('SELECT * FROM minerals WHERE is_active = true ORDER BY display_order');
    cache.set(cacheKey, { data: result.rows, timestamp: Date.now() });
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching minerals:', error);
    res.json([]);
  }
});

app.post('/api/minerals', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { name, description, image_url, display_order } = req.body;
    const newOrder = display_order || 1;

    await shiftDisplayOrders('minerals', newOrder, null, null);

    const result = await client.query(
      'INSERT INTO minerals (name, description, image_url, display_order, is_active) VALUES ($1, $2, $3, $4, true) RETURNING *',
      [name, description, image_url, newOrder]
    );

    await client.query('COMMIT');
    clearCache('minerals');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating mineral:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.put('/api/minerals/:id', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const { name, description, image_url, display_order, is_active } = req.body;

    const currentResult = await client.query('SELECT display_order FROM minerals WHERE id = $1', [id]);
    const currentOrder = currentResult.rows[0]?.display_order;

    await shiftDisplayOrders('minerals', display_order, currentOrder, id);

    const activeStatus = is_active !== undefined ? is_active : true;

    const result = await client.query(
      'UPDATE minerals SET name = $1, description = $2, image_url = $3, display_order = $4, is_active = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6 RETURNING *',
      [name, description, image_url, display_order, activeStatus, id]
    );

    await client.query('COMMIT');
    clearCache('minerals');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating mineral:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Agricultural products routes with caching
app.get('/api/agricultural-products', async (req, res) => {
  const cacheKey = 'agricultural-products';
  const cacheTime = 15000;
  
  if (cache.has(cacheKey)) {
    const { data, timestamp } = cache.get(cacheKey);
    if (Date.now() - timestamp < cacheTime) {
      return res.json(data);
    }
  }

  try {
    const result = await pool.query('SELECT * FROM agricultural_products WHERE is_active = true ORDER BY display_order');
    cache.set(cacheKey, { data: result.rows, timestamp: Date.now() });
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching agricultural products:', error);
    res.json([]);
  }
});

app.post('/api/agricultural-products', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { name, description, image_url, display_order } = req.body;
    const newOrder = display_order || 1;

    await shiftDisplayOrders('agricultural_products', newOrder, null, null);

    const result = await client.query(
      'INSERT INTO agricultural_products (name, description, image_url, display_order, is_active) VALUES ($1, $2, $3, $4, true) RETURNING *',
      [name, description, image_url, newOrder]
    );

    await client.query('COMMIT');
    clearCache('agricultural-products');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating agricultural product:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.put('/api/agricultural-products/:id', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const { name, description, image_url, display_order, is_active } = req.body;

    const currentResult = await client.query('SELECT display_order FROM agricultural_products WHERE id = $1', [id]);
    const currentOrder = currentResult.rows[0]?.display_order;

    await shiftDisplayOrders('agricultural_products', display_order, currentOrder, id);

    const activeStatus = is_active !== undefined ? is_active : true;

    const result = await client.query(
      'UPDATE agricultural_products SET name = $1, description = $2, image_url = $3, display_order = $4, is_active = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6 RETURNING *',
      [name, description, image_url, display_order, activeStatus, id]
    );

    await client.query('COMMIT');
    clearCache('agricultural-products');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating agricultural product:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.delete('/api/commitments/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM commitments WHERE id = $1', [id]);
        clearCache('commitments');
        res.json({ message: 'Commitment deleted successfully' });
    } catch (error) {
        console.error('Error deleting commitment:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/leadership/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM leadership WHERE id = $1', [id]);
        clearCache('leadership');
        res.json({ message: 'Leadership member deleted successfully' });
    } catch (error) {
        console.error('Error deleting leadership member:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/minerals/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM minerals WHERE id = $1', [id]);
        clearCache('minerals');
        res.json({ message: 'Mineral deleted successfully' });
    } catch (error) {
        console.error('Error deleting mineral:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/agricultural-products/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM agricultural_products WHERE id = $1', [id]);
        clearCache('agricultural-products');
        res.json({ message: 'Agricultural product deleted successfully' });
    } catch (error) {
        console.error('Error deleting agricultural product:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
// Agricultural division routes
app.get('/api/agricultural-division', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM agricultural_division ORDER BY id DESC LIMIT 1');
    res.json(result.rows[0] || {});
  } catch (error) {
    console.error('Error fetching agricultural division:', error);
    res.json({});
  }
});

app.post('/api/agricultural-division', authenticateToken, async (req, res) => {
  try {
    const { title, content, image_url } = req.body;
    const result = await pool.query(
      'INSERT INTO agricultural_division (title, content, image_url) VALUES ($1, $2, $3) RETURNING *',
      [title, content, image_url]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating agricultural division:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/agricultural-division/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, image_url } = req.body;
    const result = await pool.query(
      'UPDATE agricultural_division SET title = $1, content = $2, image_url = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *',
      [title, content, image_url, id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating agricultural division:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Serve admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Serve main pages
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/mining.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mining.html'));
});

app.get('/agriculture.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'agriculture.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📊 Test database connection: http://localhost:${PORT}/api/test-db`);
  console.log(`👨‍💼 Admin panel: http://localhost:${PORT}/admin`);
  console.log(`❤️ Health check: http://localhost:${PORT}/api/health`);
});