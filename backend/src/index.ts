import { createServer } from "./server.js";

const port = Number(process.env.PORT ?? 4000);
const app = createServer();

app.listen(port, () => {
  console.log(`PokerConverter API running on http://localhost:${port}`);
});
