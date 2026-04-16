const { connect } = require("puppeteer-real-browser");

async function test() {
  const { browser, page } = await connect({
    headless: false,


    turnstile: true,
  });
  await page.goto("https://www.spoj.com/EIUPROGR/status/EIUPURCHASE3,eiu23_vanhkhoi/");
}

test();