const rag = require('../rag');

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.error('Usage: node scripts/query-rag.js <query>');
  process.exit(2);
}

rag.retrieve(query, 5)
  .then((rows) => {
    for (const row of rows) {
      console.log(JSON.stringify({
        title: row.metadata?.title,
        source_path: row.metadata?.source_path,
        vector_distance: Number(row.vector_distance)
      }, null, 2));
    }
  })
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => rag.close());
