// WebMCP with Puppeteer — verified working example.
// Requires: puppeteer >=25.3.0 (already in package.json) + installed Chrome 150+.
// Run from the repo root:  node scripts/legacy/webmcp-demo.mjs
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: true,
  channel: 'chrome',                    // use system stable Chrome (150+), not the bundled build — cross-platform
  args: ['--enable-features=WebMCP'],
});

try {
  const page = await browser.newPage();

  // IMPORTANT: document.modelContext (the page-author WebMCP API) only exists in a
  // SECURE CONTEXT. about:blank / http do NOT work — navigate to an https origin first.
  await page.goto('https://example.com');

  // --- Page/author side: register a tool imperatively ---
  await page.evaluate(() => {
    document.modelContext.registerTool({
      name: 'calculate_sum',
      description: 'Adds two numbers',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
      execute: ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
    });
  });

  // --- Agent side (Puppeteer): discover + execute ---
  const tools = await page.webmcp.tools();
  console.log('discovered tools:', tools.map(t => t.name));

  const tool = tools.find(t => t.name === 'calculate_sum');
  const result = await tool.execute({ a: 5, b: 10 });
  console.log('status:', result.status, '| output:', JSON.stringify(result.content));

  // Optional: observe live tool traffic
  page.webmcp.on('toolinvoked', c => console.log('invoked:', c.tool.name, c.input));
} finally {
  await browser.close();
}
