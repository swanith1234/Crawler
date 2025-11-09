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
      useStructuralSelectors: options.useStructuralSelectors !== false,
      captureScreenshot: options.captureScreenshot || false,
      extractShadowDOM: options.extractShadowDOM !== false,
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

    // Capture screenshot if enabled
    let screenshot = null;
    if (this.options.captureScreenshot) {
      screenshot = await page.screenshot({
        encoding: "base64",
        fullPage: true,
      });
    }

    // Extract elements using multiple methods
    const elements = await page.evaluate((options) => {
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
        structuralMap: [], // NEW: For WhatsApp-like dynamic sites
      };

      // NEW: Helper to extract Shadow DOM elements
      function extractShadowDOM(element, depth = 0) {
        const shadowElements = [];
        if (depth > 5) return shadowElements; // Prevent infinite recursion

        if (element.shadowRoot) {
          const shadowChildren = element.shadowRoot.querySelectorAll("*");
          shadowChildren.forEach((child) => {
            shadowElements.push({
              element: child,
              shadowHost: element,
              depth: depth,
            });
            // Recursively check for nested shadow DOMs
            shadowElements.push(...extractShadowDOM(child, depth + 1));
          });
        }
        return shadowElements;
      }

      // NEW: Structural selector - resistant to class/id changes
      function getStructuralSelector(element) {
        const selectors = {
          // Method 1: Semantic structure (best for dynamic sites)
          semantic: null,
          // Method 2: Position-based
          positional: null,
          // Method 3: Attribute-based (non-class/id)
          attributeBased: [],
          // Method 4: Text content-based
          textBased: null,
          // Method 5: Visual position
          visualPosition: null,
          // Method 6: Parent-child relationship
          relationship: null,
        };

        // Semantic structure (aria, role, semantic HTML)
        const ariaLabel = element.getAttribute("aria-label");
        const role = element.getAttribute("role");
        const tagName = element.tagName.toLowerCase();

        if (ariaLabel) {
          selectors.semantic = `${tagName}[aria-label="${ariaLabel}"]`;
        } else if (role) {
          selectors.semantic = `${tagName}[role="${role}"]`;
        }

        // Position-based selector
        function getNthChild(el) {
          let nth = 1;
          let sibling = el.previousElementSibling;
          while (sibling) {
            if (sibling.tagName === el.tagName) nth++;
            sibling = sibling.previousElementSibling;
          }
          return nth;
        }

        let current = element;
        const pathParts = [];
        let depth = 0;

        while (current && current !== document.body && depth < 10) {
          const tag = current.tagName.toLowerCase();
          const nth = getNthChild(current);
          pathParts.unshift(`${tag}:nth-of-type(${nth})`);
          current = current.parentElement;
          depth++;
        }
        selectors.positional = pathParts.join(" > ");

        // Attribute-based (exclude class and id for dynamic sites)
        const attributes = Array.from(element.attributes);
        attributes.forEach((attr) => {
          if (!["class", "id", "style"].includes(attr.name)) {
            selectors.attributeBased.push(
              `${tagName}[${attr.name}="${attr.value}"]`
            );
          }
        });

        // Text-based selector
        const textContent = element.textContent?.trim();
        if (textContent && textContent.length < 100 && textContent.length > 0) {
          // Remove special characters for safer matching
          const safeText = textContent.replace(/['"]/g, "");
          selectors.textBased = `${tagName}:has-text("${safeText}")`;
        }

        // Visual position (useful for consistent layouts)
        const rect = element.getBoundingClientRect();
        selectors.visualPosition = {
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          selector: `element-at-${Math.round(rect.top)}-${Math.round(
            rect.left
          )}`,
        };

        // Parent-child relationship
        if (element.parentElement) {
          const parentTag = element.parentElement.tagName.toLowerCase();
          const parentAria = element.parentElement.getAttribute("aria-label");
          if (parentAria) {
            selectors.relationship = `${parentTag}[aria-label="${parentAria}"] > ${tagName}`;
          }
        }

        return selectors;
      }

      // Helper function to get unique selector (original + enhanced)
      function getUniqueSelector(element, useStructural = true) {
        const selectors = [];
        const structural = useStructural
          ? getStructuralSelector(element)
          : null;

        // Prioritize structural selectors for dynamic sites
        if (structural) {
          if (structural.semantic) selectors.push(structural.semantic);
          structural.attributeBased.forEach((s) => selectors.push(s));
          if (structural.relationship) selectors.push(structural.relationship);
          if (structural.textBased) selectors.push(structural.textBased);
          if (structural.positional) selectors.push(structural.positional);
        }

        // Method 1: ID (less reliable for dynamic sites but still useful)
        if (element.id && !element.id.match(/^[a-f0-9-]{20,}$/)) {
          // Exclude random IDs
          selectors.push(`#${element.id}`);
        }

        // Method 2: Name attribute
        if (element.name) {
          selectors.push(`[name="${element.name}"]`);
        }

        // Method 3: Stable data attributes (common in React apps)
        for (const attr of element.attributes) {
          if (
            attr.name.startsWith("data-") &&
            !attr.value.match(/^[a-f0-9-]{20,}$/)
          ) {
            // Exclude random values
            selectors.push(`[${attr.name}="${attr.value}"]`);
          }
        }

        // Method 4: Aria labels (very stable)
        if (element.getAttribute("aria-label")) {
          selectors.push(
            `[aria-label="${element.getAttribute("aria-label")}"]`
          );
        }

        // Method 5: Title attribute
        if (element.title) {
          selectors.push(`[title="${element.title}"]`);
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

        // Method 8: Placeholder (stable in many apps)
        if (element.placeholder) {
          selectors.push(`[placeholder="${element.placeholder}"]`);
        }

        // Method 9: Test IDs (common in modern frameworks)
        const testId =
          element.getAttribute("data-testid") ||
          element.getAttribute("data-test-id") ||
          element.getAttribute("data-test");
        if (testId) {
          selectors.push(`[data-testid="${testId}"]`);
        }

        // XPath (multiple strategies)
        const xpaths = [];

        // XPath by aria-label
        if (element.getAttribute("aria-label")) {
          xpaths.push(
            `//*[@aria-label="${element.getAttribute("aria-label")}"]`
          );
        }

        // XPath by text content
        const text = element.textContent?.trim();
        if (text && text.length < 100) {
          xpaths.push(
            `//${element.tagName.toLowerCase()}[contains(text(), "${text.substring(
              0,
              50
            )}")]`
          );
        }

        // Traditional XPath
        function getXPath(el) {
          if (el.id && !el.id.match(/^[a-f0-9-]{20,}$/)) {
            return `//*[@id="${el.id}"]`;
          }
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

        xpaths.push(getXPath(element));

        // CSS Path
        function getCssPath(el) {
          if (!(el instanceof Element)) return;
          const path = [];
          while (el.nodeType === Node.ELEMENT_NODE) {
            let selector = el.nodeName.toLowerCase();
            if (el.id && !el.id.match(/^[a-f0-9-]{20,}$/)) {
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
          xpaths,
          xpath: xpaths[0],
          cssPath,
          preferredSelector: selectors[0] || cssPath,
          structural,
          // Selector confidence score
          confidence:
            selectors.length > 0
              ? structural?.semantic
                ? "high"
                : structural?.attributeBased.length > 0
                ? "medium"
                : "low"
              : "low",
        };
      }

      // Helper function to extract element info (enhanced)
      function extractElementInfo(element, useStructural = true) {
        const selectorInfo = getUniqueSelector(element, useStructural);

        // Compute element fingerprint (for matching across sessions)
        const fingerprint = [
          element.tagName,
          element.getAttribute("role"),
          element.getAttribute("aria-label"),
          element.placeholder,
          element.type,
          element.title,
        ]
          .filter(Boolean)
          .join("::");

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
          ariaDescribedBy: element.getAttribute("aria-describedby") || null,
          ariaControls: element.getAttribute("aria-controls") || null,
          role: element.getAttribute("role") || null,
          title: element.title || null,
          alt: element.alt || null,
          tabIndex: element.tabIndex,
          dataAttributes: Array.from(element.attributes)
            .filter((attr) => attr.name.startsWith("data-"))
            .reduce((acc, attr) => {
              acc[attr.name] = attr.value;
              return acc;
            }, {}),
          selectors: selectorInfo.selectors,
          xpaths: selectorInfo.xpaths,
          xpath: selectorInfo.xpath,
          cssPath: selectorInfo.cssPath,
          preferredSelector: selectorInfo.preferredSelector,
          structural: selectorInfo.structural,
          confidence: selectorInfo.confidence,
          fingerprint,
          boundingBox: element.getBoundingClientRect(),
          isVisible:
            element.offsetParent !== null &&
            element.getBoundingClientRect().width > 0 &&
            element.getBoundingClientRect().height > 0,
          computedStyle: {
            display: window.getComputedStyle(element).display,
            visibility: window.getComputedStyle(element).visibility,
            opacity: window.getComputedStyle(element).opacity,
          },
          innerHTML: element.innerHTML?.substring(0, 500) || null,
          outerHTML: element.outerHTML?.substring(0, 500) || null,
        };
      }

      // Extract Shadow DOM elements if enabled
      let shadowElements = [];
      if (options.extractShadowDOM) {
        document.querySelectorAll("*").forEach((el) => {
          shadowElements.push(...extractShadowDOM(el));
        });
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
        "[onclick]",
      ];

      buttonSelectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((el) => {
          results.buttons.push(
            extractElementInfo(el, options.useStructuralSelectors)
          );
        });
      });

      // Extract inputs
      document.querySelectorAll("input, textarea").forEach((el) => {
        const info = extractElementInfo(el, options.useStructuralSelectors);
        if (el.tagName === "TEXTAREA") {
          results.textareas.push(info);
        }
        results.inputs.push(info);
      });

      // Extract links
      document.querySelectorAll("a").forEach((el) => {
        results.links.push(
          extractElementInfo(el, options.useStructuralSelectors)
        );
      });

      // Extract forms
      document.querySelectorAll("form").forEach((el) => {
        results.forms.push(
          extractElementInfo(el, options.useStructuralSelectors)
        );
      });

      // Extract headings
      document.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((el) => {
        results.headings.push(
          extractElementInfo(el, options.useStructuralSelectors)
        );
      });

      // Extract images
      document.querySelectorAll("img").forEach((el) => {
        results.images.push(
          extractElementInfo(el, options.useStructuralSelectors)
        );
      });

      // Extract videos
      document.querySelectorAll("video").forEach((el) => {
        results.videos.push(
          extractElementInfo(el, options.useStructuralSelectors)
        );
      });

      // Extract iframes
      document.querySelectorAll("iframe").forEach((el) => {
        results.iframes.push(
          extractElementInfo(el, options.useStructuralSelectors)
        );
      });

      // Extract selects
      document.querySelectorAll("select").forEach((el) => {
        const info = extractElementInfo(el, options.useStructuralSelectors);
        info.options = Array.from(el.options).map((opt) => ({
          value: opt.value,
          text: opt.text,
          selected: opt.selected,
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
        '[tabindex="0"]',
      ];

      clickableSelectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((el) => {
          results.clickables.push(
            extractElementInfo(el, options.useStructuralSelectors)
          );
        });
      });

      // Extract ALL interactive elements
      document.querySelectorAll("*").forEach((el) => {
        // Filter out script, style, and meta tags
        if (
          !["SCRIPT", "STYLE", "META", "LINK", "NOSCRIPT"].includes(el.tagName)
        ) {
          const info = extractElementInfo(el, options.useStructuralSelectors);

          // Add interaction probability score
          info.interactionScore = 0;
          if (el.onclick || el.getAttribute("onclick"))
            info.interactionScore += 3;
          if (el.getAttribute("role") === "button") info.interactionScore += 3;
          if (el.tagName === "BUTTON") info.interactionScore += 3;
          if (el.tagName === "A") info.interactionScore += 2;
          if (el.tabIndex >= 0) info.interactionScore += 1;
          if (info.ariaLabel) info.interactionScore += 1;
          if (el.classList.toString().match(/button|click|action/i))
            info.interactionScore += 2;

          results.allElements.push(info);
        }
      });

      // Process shadow DOM elements
      shadowElements.forEach(({ element, shadowHost, depth }) => {
        const info = extractElementInfo(
          element,
          options.useStructuralSelectors
        );
        info.shadowDOM = {
          depth,
          hostSelector: getUniqueSelector(
            shadowHost,
            options.useStructuralSelectors
          ).preferredSelector,
        };
        results.allElements.push(info);
      });

      // Create structural map (useful for understanding page structure)
      const createStructuralMap = () => {
        const map = [];
        const traverse = (element, depth = 0) => {
          if (depth > 15 || !element) return;

          const info = {
            tag: element.tagName?.toLowerCase(),
            role: element.getAttribute?.("role"),
            ariaLabel: element.getAttribute?.("aria-label"),
            childCount: element.children?.length || 0,
            depth,
            hasText: (element.textContent?.trim().length || 0) > 0,
            isInteractive:
              ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(
                element.tagName
              ) ||
              element.getAttribute?.("role") === "button" ||
              element.onclick !== undefined,
          };

          map.push(info);

          Array.from(element.children || []).forEach((child) => {
            traverse(child, depth + 1);
          });
        };

        traverse(document.body);
        return map;
      };

      results.structuralMap = createStructuralMap();

      // Remove duplicates based on fingerprint
      Object.keys(results).forEach((key) => {
        if (key === "structuralMap") return;

        const seen = new Set();
        results[key] = results[key].filter((item) => {
          const id = item.fingerprint || item.xpath || item.cssPath;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
      });

      return results;
    }, this.options);

    return {
      source: "puppeteer",
      url,
      timestamp: new Date().toISOString(),
      htmlSource,
      screenshot,
      elements,
      metadata: {
        totalElements: elements.allElements.length,
        highConfidenceElements: elements.allElements.filter(
          (e) => e.confidence === "high"
        ).length,
        interactiveElements: elements.allElements.filter(
          (e) => e.interactionScore > 2
        ).length,
      },
    };
  }

  // Enhanced method to interact with elements using ALL fallback strategies
  async clickElement(page, elementInfo) {
    const strategies = [
      // Strategy 1: Structural selectors (best for dynamic sites)
      ...(elementInfo.structural?.semantic
        ? [elementInfo.structural.semantic]
        : []),
      ...(elementInfo.structural?.attributeBased || []),
      ...(elementInfo.structural?.relationship
        ? [elementInfo.structural.relationship]
        : []),

      // Strategy 2: Stable attributes
      elementInfo.ariaLabel ? `[aria-label="${elementInfo.ariaLabel}"]` : null,
      elementInfo.role ? `[role="${elementInfo.role}"]` : null,
      elementInfo.placeholder
        ? `[placeholder="${elementInfo.placeholder}"]`
        : null,
      elementInfo.title ? `[title="${elementInfo.title}"]` : null,

      // Strategy 3: Preferred selectors
      elementInfo.preferredSelector,
      ...(elementInfo.selectors || []),

      // Strategy 4: CSS Path
      elementInfo.cssPath,

      // Strategy 5: Traditional attributes
      elementInfo.id ? `#${elementInfo.id}` : null,
      elementInfo.name ? `[name="${elementInfo.name}"]` : null,
    ].filter(Boolean);

    // Try CSS selectors
    for (const selector of strategies) {
      try {
        await page.waitForSelector(selector, { timeout: 2000 });
        await page.click(selector, { timeout: 5000 });
        console.log(`✓ Clicked using selector: ${selector}`);
        return { success: true, method: "css", selector };
      } catch (error) {
        // Continue to next strategy
      }
    }

    // Try all XPaths
    if (elementInfo.xpaths) {
      for (const xpath of elementInfo.xpaths) {
        try {
          const [element] = await page.$x(xpath);
          if (element) {
            await element.click();
            console.log(`✓ Clicked using XPath: ${xpath}`);
            return { success: true, method: "xpath", selector: xpath };
          }
        } catch (error) {
          // Continue to next XPath
        }
      }
    }

    // Try by text content
    if (elementInfo.text) {
      try {
        const textSelector = `${
          elementInfo.tag
        }:has-text("${elementInfo.text.substring(0, 50)}")`;
        await page.click(textSelector);
        console.log(
          `✓ Clicked using text: ${elementInfo.text.substring(0, 50)}`
        );
        return { success: true, method: "text", selector: textSelector };
      } catch (error) {
        // Continue
      }
    }

    // Try by visual position (coordinates)
    if (elementInfo.boundingBox && elementInfo.boundingBox.width > 0) {
      try {
        const x =
          elementInfo.boundingBox.left + elementInfo.boundingBox.width / 2;
        const y =
          elementInfo.boundingBox.top + elementInfo.boundingBox.height / 2;
        await page.mouse.click(x, y);
        console.log(`✓ Clicked using coordinates: (${x}, ${y})`);
        return { success: true, method: "coordinates", position: { x, y } };
      } catch (error) {
        // Continue
      }
    }

    // Last resort: Try to find similar elements by fingerprint
    try {
      const similarElement = await page.evaluate((fingerprint) => {
        const allElements = document.querySelectorAll("*");
        for (const el of allElements) {
          const elFingerprint = [
            el.tagName,
            el.getAttribute("role"),
            el.getAttribute("aria-label"),
            el.placeholder,
            el.type,
            el.title,
          ]
            .filter(Boolean)
            .join("::");

          if (elFingerprint === fingerprint) {
            el.click();
            return true;
          }
        }
        return false;
      }, elementInfo.fingerprint);

      if (similarElement) {
        console.log(`✓ Clicked using fingerprint match`);
        return { success: true, method: "fingerprint" };
      }
    } catch (error) {
      // Final failure
    }

    console.log(`✗ Failed to click element after all strategies`);
    return { success: false, error: "All click strategies failed" };
  }

  // NEW: Smart element finder - finds element even if selectors changed
  async findElement(page, elementInfo) {
    // Try exact match first
    const exactMatch = await this.clickElement(page, elementInfo);
    if (exactMatch.success) {
      return exactMatch;
    }

    // Fuzzy matching based on element characteristics
    const fuzzyMatch = await page.evaluate((info) => {
      const candidates = Array.from(document.querySelectorAll("*"));

      const scoreCandidates = candidates.map((el) => {
        let score = 0;

        // Same tag type
        if (el.tagName.toLowerCase() === info.tag) score += 10;

        // Similar text content
        if (info.text && el.textContent?.includes(info.text.substring(0, 50)))
          score += 20;

        // Same role
        if (info.role && el.getAttribute("role") === info.role) score += 15;

        // Same aria-label
        if (info.ariaLabel && el.getAttribute("aria-label") === info.ariaLabel)
          score += 25;

        // Similar position
        if (info.boundingBox) {
          const rect = el.getBoundingClientRect();
          const positionDiff =
            Math.abs(rect.top - info.boundingBox.top) +
            Math.abs(rect.left - info.boundingBox.left);
          if (positionDiff < 50) score += 15;
        }

        // Same placeholder
        if (info.placeholder && el.placeholder === info.placeholder)
          score += 20;

        return { element: el, score };
      });

      // Find best match
      const best = scoreCandidates.sort((a, b) => b.score - a.score)[0];

      if (best && best.score > 30) {
        return {
          found: true,
          score: best.score,
          tag: best.element.tagName,
          text: best.element.textContent?.substring(0, 100),
        };
      }

      return { found: false };
    }, elementInfo);

    return fuzzyMatch;
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
