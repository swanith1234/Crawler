const puppeteer = require("puppeteer");

class AdvancedWebCrawler {
  constructor(options = {}) {
    this.options = {
      headless: options.headless !== false,
      timeout: options.timeout || 30000,
      waitForSelector: options.waitForSelector || 2000,
      userAgent:
        options.userAgent ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      ...options,
    };
  }

  async crawl(url) {
    const browser = await puppeteer.launch({
      headless: this.options.headless,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    try {
      const page = await browser.newPage();

      // Anti-detection measures
      await this.setupAntiDetection(page);

      // Navigate to URL
      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: this.options.timeout,
      });

      // Wait for dynamic content
      await page.waitForTimeout(this.options.waitForSelector);

      // Extract all data
      const data = await this.extractAllData(page, url);

      return data;
    } finally {
      await browser.close();
    }
  }

  async setupAntiDetection(page) {
    // Set user agent
    await page.setUserAgent(this.options.userAgent);

    // Remove webdriver flag
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });

      // Mock chrome object
      window.chrome = { runtime: {} };

      // Mock permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    });

    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });
  }

  async extractAllData(page, url) {
    // Get full HTML source
    const htmlSource = await page.content();

    // Extract elements using multiple methods
    const elements = await page.evaluate(() => {
      const results = {
        buttons: [],
        inputs: [],
        links: [],
        forms: [],
        headings: [],
        images: [],
        videos: [],
        iframes: [],
        textareas: [],
        selects: [],
        clickables: [],
        allElements: [],
      };

      // Helper function to get unique selector
      function getUniqueSelector(element) {
        const selectors = [];

        // Method 1: ID
        if (element.id) {
          selectors.push(`#${element.id}`);
        }

        // Method 2: Name attribute
        if (element.name) {
          selectors.push(`[name="${element.name}"]`);
        }

        // Method 3: Class combinations
        if (element.className && typeof element.className === "string") {
          const classes = element.className
            .trim()
            .split(/\s+/)
            .filter((c) => c);
          if (classes.length > 0) {
            selectors.push(`.${classes.join(".")}`);
          }
        }

        // Method 4: Data attributes
        for (const attr of element.attributes) {
          if (attr.name.startsWith("data-")) {
            selectors.push(`[${attr.name}="${attr.value}"]`);
          }
        }

        // Method 5: Aria labels
        if (element.getAttribute("aria-label")) {
          selectors.push(
            `[aria-label="${element.getAttribute("aria-label")}"]`
          );
        }

        // Method 6: Role
        if (element.getAttribute("role")) {
          selectors.push(`[role="${element.getAttribute("role")}"]`);
        }

        // Method 7: Type for inputs
        if (element.type) {
          selectors.push(
            `${element.tagName.toLowerCase()}[type="${element.type}"]`
          );
        }

        // Method 8: Text content for buttons/links (first 50 chars)
        if (
          (element.tagName === "BUTTON" || element.tagName === "A") &&
          element.textContent
        ) {
          const text = element.textContent.trim().substring(0, 50);
          if (text) {
            selectors.push(
              `${element.tagName.toLowerCase()}:contains("${text}")`
            );
          }
        }

        // Method 9: XPath
        function getXPath(el) {
          if (el.id) return `//*[@id="${el.id}"]`;
          if (el === document.body) return "/html/body";

          let ix = 0;
          const siblings = el.parentNode?.childNodes || [];
          for (let i = 0; i < siblings.length; i++) {
            const sibling = siblings[i];
            if (sibling === el) {
              return (
                getXPath(el.parentNode) +
                "/" +
                el.tagName.toLowerCase() +
                "[" +
                (ix + 1) +
                "]"
              );
            }
            if (sibling.nodeType === 1 && sibling.tagName === el.tagName) {
              ix++;
            }
          }
        }

        const xpath = getXPath(element);

        // Method 10: CSS Path
        function getCssPath(el) {
          if (!(el instanceof Element)) return;
          const path = [];
          while (el.nodeType === Node.ELEMENT_NODE) {
            let selector = el.nodeName.toLowerCase();
            if (el.id) {
              selector += "#" + el.id;
              path.unshift(selector);
              break;
            } else {
              let sibling = el;
              let nth = 1;
              while (sibling.previousElementSibling) {
                sibling = sibling.previousElementSibling;
                if (sibling.nodeName.toLowerCase() === selector) nth++;
              }
              if (nth !== 1) selector += `:nth-of-type(${nth})`;
            }
            path.unshift(selector);
            el = el.parentNode;
          }
          return path.join(" > ");
        }

        const cssPath = getCssPath(element);

        return {
          selectors,
          xpath,
          cssPath,
          preferredSelector: selectors[0] || cssPath,
        };
      }

      // Helper function to extract element info
      function extractElementInfo(element) {
        const selectorInfo = getUniqueSelector(element);

        return {
          tag: element.tagName.toLowerCase(),
          text: element.textContent?.trim().substring(0, 200) || null,
          href: element.href || null,
          src: element.src || null,
          id: element.id || null,
          class: element.className || null,
          name: element.name || null,
          type: element.type || null,
          placeholder: element.placeholder || null,
          value: element.value || null,
          ariaLabel: element.getAttribute("aria-label") || null,
          role: element.getAttribute("role") || null,
          title: element.title || null,
          alt: element.alt || null,
          dataAttributes: Array.from(element.attributes)
            .filter((attr) => attr.name.startsWith("data-"))
            .reduce((acc, attr) => {
              acc[attr.name] = attr.value;
              return acc;
            }, {}),
          selectors: selectorInfo.selectors,
          xpath: selectorInfo.xpath,
          cssPath: selectorInfo.cssPath,
          preferredSelector: selectorInfo.preferredSelector,
          boundingBox: element.getBoundingClientRect(),
          isVisible: element.offsetParent !== null,
          innerHTML: element.innerHTML?.substring(0, 500) || null,
        };
      }

      // Extract buttons (including role="button")
      const buttonSelectors = [
        "button",
        'input[type="button"]',
        'input[type="submit"]',
        '[role="button"]',
        ".btn",
        ".button",
        '[class*="button"]',
        "a.button",
        "a.btn",
      ];

      buttonSelectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((el) => {
          results.buttons.push(extractElementInfo(el));
        });
      });

      // Extract inputs
      document.querySelectorAll("input, textarea").forEach((el) => {
        const info = extractElementInfo(el);
        if (el.tagName === "TEXTAREA") {
          results.textareas.push(info);
        }
        results.inputs.push(info);
      });

      // Extract links
      document.querySelectorAll("a").forEach((el) => {
        results.links.push(extractElementInfo(el));
      });

      // Extract forms
      document.querySelectorAll("form").forEach((el) => {
        results.forms.push(extractElementInfo(el));
      });

      // Extract headings
      document.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((el) => {
        results.headings.push(extractElementInfo(el));
      });

      // Extract images
      document.querySelectorAll("img").forEach((el) => {
        results.images.push(extractElementInfo(el));
      });

      // Extract videos
      document.querySelectorAll("video").forEach((el) => {
        results.videos.push(extractElementInfo(el));
      });

      // Extract iframes
      document.querySelectorAll("iframe").forEach((el) => {
        results.iframes.push(extractElementInfo(el));
      });

      // Extract selects
      document.querySelectorAll("select").forEach((el) => {
        const info = extractElementInfo(el);
        info.options = Array.from(el.options).map((opt) => ({
          value: opt.value,
          text: opt.text,
        }));
        results.selects.push(info);
      });

      // Extract all clickable elements
      const clickableSelectors = [
        "a",
        "button",
        'input[type="button"]',
        'input[type="submit"]',
        "[onclick]",
        '[role="button"]',
        '[role="link"]',
        '[class*="click"]',
        '[class*="btn"]',
      ];

      clickableSelectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((el) => {
          results.clickables.push(extractElementInfo(el));
        });
      });

      // Extract ALL elements (useful for complex pages)
      document.querySelectorAll("*").forEach((el) => {
        // Filter out script, style, and meta tags
        if (
          !["SCRIPT", "STYLE", "META", "LINK", "NOSCRIPT"].includes(el.tagName)
        ) {
          results.allElements.push(extractElementInfo(el));
        }
      });

      // Remove duplicates
      Object.keys(results).forEach((key) => {
        const seen = new Set();
        results[key] = results[key].filter((item) => {
          const id = item.xpath || item.cssPath;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
      });

      return results;
    });

    return {
      source: "puppeteer",
      url,
      timestamp: new Date().toISOString(),
      htmlSource,
      elements,
    };
  }

  // Method to interact with elements using multiple fallback selectors
  async clickElement(page, elementInfo) {
    const selectors = [
      elementInfo.preferredSelector,
      ...(elementInfo.selectors || []),
      elementInfo.cssPath,
      elementInfo.id ? `#${elementInfo.id}` : null,
      elementInfo.name ? `[name="${elementInfo.name}"]` : null,
    ].filter(Boolean);

    for (const selector of selectors) {
      try {
        await page.click(selector, { timeout: 5000 });
        console.log(`✓ Clicked using selector: ${selector}`);
        return true;
      } catch (error) {
        console.log(`✗ Failed with selector: ${selector}`);
      }
    }

    // Fallback: Use XPath
    if (elementInfo.xpath) {
      try {
        const [element] = await page.$x(elementInfo.xpath);
        if (element) {
          await element.click();
          console.log(`✓ Clicked using XPath: ${elementInfo.xpath}`);
          return true;
        }
      } catch (error) {
        console.log(`✗ Failed with XPath: ${elementInfo.xpath}`);
      }
    }

    // Fallback: Click by coordinates
    if (elementInfo.boundingBox) {
      try {
        const x =
          elementInfo.boundingBox.left + elementInfo.boundingBox.width / 2;
        const y =
          elementInfo.boundingBox.top + elementInfo.boundingBox.height / 2;
        await page.mouse.click(x, y);
        console.log(`✓ Clicked using coordinates: (${x}, ${y})`);
        return true;
      } catch (error) {
        console.log(`✗ Failed with coordinates`);
      }
    }

    return false;
  }
}

// Usage example
async function main() {
  const crawler = new AdvancedWebCrawler({
    headless: false,
    timeout: 30000,
    waitForSelector: 3000,
  });

  try {
    const data = await crawler.crawl("https://www.google.com");

    console.log("Crawl Results:");
    console.log("Buttons found:", data.elements.buttons.length);
    console.log("Inputs found:", data.elements.inputs.length);
    console.log("Links found:", data.elements.links.length);
    console.log("All elements found:", data.elements.allElements.length);

    // Save to JSON file
    const fs = require("fs");
    fs.writeFileSync("crawl_results.json", JSON.stringify(data, null, 2));
    console.log("Results saved to crawl_results.json");

    // Example: Click on first button using fallback methods
    // const browser = await puppeteer.launch({ headless: false });
    // const page = await browser.newPage();
    // await page.goto('https://www.google.com');
    // const clicked = await crawler.clickElement(page, data.elements.buttons[0]);
    // console.log('Button clicked:', clicked);
    // await browser.close();
  } catch (error) {
    console.error("Crawl failed:", error);
  }
}

// Export for use in other modules
module.exports = { AdvancedWebCrawler };

// Run if executed directly
if (require.main === module) {
  main();
}
