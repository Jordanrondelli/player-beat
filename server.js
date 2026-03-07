const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory vote storage
const votes = { fire: 430, up: 96, down: 111 };

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Get current votes
app.get('/api/votes', (req, res) => {
  res.json(votes);
});

// Cast a vote
app.post('/api/votes', (req, res) => {
  const { type } = req.body;
  if (!type || !['fire', 'up', 'down'].includes(type)) {
    return res.status(400).json({ error: 'Type must be fire, up, or down' });
  }
  const amount = type === 'fire' ? 5 : 1;
  votes[type] += amount;
  res.json(votes);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
