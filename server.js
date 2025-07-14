const express = require('express');
const app = express();
const PORT = 3000;

// Serve everything in the "public" folder
app.use(express.static('public'));
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});