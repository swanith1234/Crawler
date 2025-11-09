// complete-automation-system.js
const express = require("express");
const { AdvancedWebCrawler } = require("./advanced_web_crawler");
const fs = require("fs").promises;
const path = require("path");

const app = express();
app.use(express.json({ limit: "100mb" }));

// In-memory database (replace with PostgreSQL/MongoDB in production)
const database = {
  pages: new Map(), // url -> page data
  elements: new Map(), // pageId -> elements array
  actions: new Map(), // actionId -> action history
};

// ==========================================
// STEP 1: EXTRACT & STORE ALL ELEMENTS
// ==========================================

app.post("/api/extract", async (req, res) => {
  try {
    const { url, pageName, options = {} } = req.body;

    if (!url) {
      return res.status(400).json({ error: "URL is required" });
    }

    console.log(`[EXTRACT] Starting extraction for: ${url}`);

    // Initialize crawler with all advanced options
    const crawler = new AdvancedWebCrawler({
      headless: true,
      timeout: 30000,
      waitForSelector: 5000,
      useStructuralSelectors: true,
      captureScreenshot: true,
      extractShadowDOM: true,
      ...options,
    });

    // Crawl the page
    const crawlData = await crawler.crawl(url);

    // Create page ID
    const pageId = pageName || new URL(url).hostname.replace(/\./g, "_");
    const timestamp = Date.now();

    // Enrich element data with automation metadata
    const enrichedElements = enrichElementsForAutomation(crawlData.elements);

    // Store page info
    const pageInfo = {
      id: pageId,
      url: url,
      extractedAt: timestamp,
      metadata: crawlData.metadata,
      screenshot: crawlData.screenshot,
      structuralMap: crawlData.elements.structuralMap,
      totalElements: enrichedElements.length,
    };

    database.pages.set(pageId, pageInfo);
    database.elements.set(pageId, enrichedElements);

    // Save to disk for persistence
    await saveToFile(pageId, {
      pageInfo,
      elements: enrichedElements,
    });

    console.log(
      `[EXTRACT] Completed. Stored ${enrichedElements.length} elements for ${pageId}`
    );

    res.json({
      success: true,
      pageId,
      summary: {
        url,
        totalElements: enrichedElements.length,
        interactiveElements: enrichedElements.filter(
          (e) => e.automationMeta.isInteractive
        ).length,
        highConfidenceElements: enrichedElements.filter(
          (e) => e.automationMeta.confidence === "high"
        ).length,
        elementTypes: getElementTypeCounts(enrichedElements),
      },
      message: `Successfully extracted and stored ${enrichedElements.length} elements from ${url}`,
    });
  } catch (error) {
    console.error("[EXTRACT] Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

// ==========================================
// STEP 2: QUERY STORED ELEMENTS
// ==========================================

app.get("/api/pages", async (req, res) => {
  const pages = Array.from(database.pages.values()).map((p) => ({
    id: p.id,
    url: p.url,
    extractedAt: new Date(p.extractedAt).toISOString(),
    totalElements: p.totalElements,
    hasScreenshot: !!p.screenshot,
  }));

  res.json({ success: true, pages });
});

app.get("/api/pages/:pageId", async (req, res) => {
  const { pageId } = req.params;
  const pageInfo = database.pages.get(pageId);
  const elements = database.elements.get(pageId);

  if (!pageInfo) {
    return res.status(404).json({ error: "Page not found" });
  }

  res.json({
    success: true,
    page: pageInfo,
    elementsSummary: {
      total: elements.length,
      interactive: elements.filter((e) => e.automationMeta.isInteractive)
        .length,
      byType: getElementTypeCounts(elements),
    },
  });
});

app.get("/api/pages/:pageId/elements", async (req, res) => {
  const { pageId } = req.params;
  const { type, interactive, minConfidence } = req.query;

  let elements = database.elements.get(pageId);

  if (!elements) {
    return res.status(404).json({ error: "Page not found" });
  }

  // Apply filters
  if (type) {
    elements = elements.filter((e) => e.automationMeta.category === type);
  }
  if (interactive === "true") {
    elements = elements.filter((e) => e.automationMeta.isInteractive);
  }
  if (minConfidence) {
    const confidenceLevels = { high: 3, medium: 2, low: 1 };
    const minLevel = confidenceLevels[minConfidence] || 1;
    elements = elements.filter(
      (e) => confidenceLevels[e.automationMeta.confidence] >= minLevel
    );
  }

  res.json({
    success: true,
    pageId,
    count: elements.length,
    elements: elements.map((e) => ({
      id: e.id,
      category: e.automationMeta.category,
      description: e.automationMeta.description,
      confidence: e.automationMeta.confidence,
      selectors: e.automationMeta.allSelectors.slice(0, 3),
      actions: e.automationMeta.supportedActions,
    })),
  });
});

// ==========================================
// STEP 3: GENERATE AUTOMATION CODE
// ==========================================

app.post("/api/generate-automation", async (req, res) => {
  try {
    const {
      pageId,
      userIntent, // Natural language: "click on send button", "fill in email field with test@example.com"
      llmProvider = "openai", // 'openai' or 'claude'
      generateCode = true, // Whether to generate executable code
    } = req.body;

    if (!pageId || !userIntent) {
      return res
        .status(400)
        .json({ error: "pageId and userIntent are required" });
    }

    const pageInfo = database.pages.get(pageId);
    const elements = database.elements.get(pageId);

    if (!pageInfo || !elements) {
      return res.status(404).json({ error: "Page not found" });
    }

    console.log(`[GENERATE] User intent: "${userIntent}" for page: ${pageId}`);

    // Prepare context for LLM
    const context = prepareAutomationContext(pageInfo, elements, userIntent);

    // Call LLM to analyze and generate automation plan
    const automationPlan = await callLLM(context, llmProvider, req.body.apiKey);

    // Generate executable code if requested
    let code = null;
    if (generateCode && automationPlan.steps) {
      code = generateAutomationCode(automationPlan, pageInfo.url);
    }

    // Store the plan
    const actionId = `action_${Date.now()}`;
    database.actions.set(actionId, {
      actionId,
      pageId,
      userIntent,
      plan: automationPlan,
      code,
      createdAt: Date.now(),
      executed: false,
    });

    res.json({
      success: true,
      actionId,
      plan: automationPlan,
      code: code
        ? {
            language: "javascript",
            framework: "puppeteer",
            content: code,
          }
        : null,
      message: "Automation plan generated successfully",
    });
  } catch (error) {
    console.error("[GENERATE] Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==========================================
// STEP 4: EXECUTE AUTOMATION
// ==========================================

app.post("/api/execute", async (req, res) => {
  try {
    const {
      actionId,
      pageId,
      plan, // Optional: provide plan directly
      dryRun = false, // Test without actually executing
    } = req.body;

    let automationPlan;
    let targetPageId;

    if (actionId) {
      const action = database.actions.get(actionId);
      if (!action) {
        return res.status(404).json({ error: "Action not found" });
      }
      automationPlan = action.plan;
      targetPageId = action.pageId;
    } else if (pageId && plan) {
      automationPlan = plan;
      targetPageId = pageId;
    } else {
      return res
        .status(400)
        .json({ error: "Either actionId or (pageId + plan) is required" });
    }

    const pageInfo = database.pages.get(targetPageId);
    const elements = database.elements.get(targetPageId);

    if (!pageInfo || !elements) {
      return res.status(404).json({ error: "Page not found" });
    }

    console.log(
      `[EXECUTE] Executing automation for ${targetPageId}. Dry run: ${dryRun}`
    );

    // Execute the automation
    const result = await executeAutomation(
      automationPlan,
      pageInfo.url,
      elements,
      dryRun
    );

    // Update action status
    if (actionId) {
      const action = database.actions.get(actionId);
      action.executed = !dryRun;
      action.executedAt = Date.now();
      action.result = result;
      database.actions.set(actionId, action);
    }

    res.json({
      success: true,
      result,
      dryRun,
      message: dryRun
        ? "Dry run completed"
        : "Automation executed successfully",
    });
  } catch (error) {
    console.error("[EXECUTE] Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function enrichElementsForAutomation(rawElements) {
  const allElements = rawElements.allElements || [];

  return allElements.map((element, index) => {
    const automationMeta = {
      id: `elem_${index}`,
      category: categorizeElement(element),
      description: generateElementDescription(element),
      isInteractive: element.interactionScore > 2,
      confidence: element.confidence || "low",
      supportedActions: getSupportedActions(element),
      allSelectors: getAllSelectors(element),
      primarySelector: element.preferredSelector,
      fallbackMethods: generateFallbackMethods(element),
      semanticInfo: {
        purpose: inferElementPurpose(element),
        label:
          element.ariaLabel ||
          element.placeholder ||
          element.title ||
          element.text?.substring(0, 50),
        type: element.tag,
      },
    };

    return {
      ...element,
      id: automationMeta.id,
      automationMeta,
    };
  });
}

function categorizeElement(element) {
  const tag = element.tag.toLowerCase();
  const role = element.role;

  if (tag === "button" || role === "button") return "button";
  if (tag === "input" && element.type === "text") return "input_text";
  if (tag === "input" && element.type === "password") return "input_password";
  if (tag === "input" && element.type === "email") return "input_email";
  if (tag === "input" && element.type === "submit") return "submit_button";
  if (tag === "textarea") return "textarea";
  if (tag === "select") return "dropdown";
  if (tag === "a") return "link";
  if (tag === "form") return "form";
  if (["h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) return "heading";
  if (tag === "img") return "image";
  if (role === "checkbox") return "checkbox";
  if (role === "radio") return "radio";
  if (element.onclick || element.interactionScore > 2) return "clickable";

  return "generic";
}

function generateElementDescription(element) {
  const parts = [];

  if (element.ariaLabel) parts.push(element.ariaLabel);
  else if (element.placeholder)
    parts.push(`Placeholder: "${element.placeholder}"`);
  else if (element.title) parts.push(element.title);
  else if (element.text) parts.push(element.text.substring(0, 100));

  if (element.tag) parts.push(`(${element.tag})`);
  if (element.role) parts.push(`[role=${element.role}]`);

  return parts.join(" ") || "Unlabeled element";
}

function getSupportedActions(element) {
  const actions = [];
  const category = categorizeElement(element);

  if (["button", "link", "clickable", "submit_button"].includes(category)) {
    actions.push("click", "hover");
  }
  if (category.startsWith("input_") || category === "textarea") {
    actions.push("type", "clear", "fill");
  }
  if (category === "dropdown") {
    actions.push("select");
  }
  if (category === "checkbox" || category === "radio") {
    actions.push("check", "uncheck");
  }

  return actions;
}

function getAllSelectors(element) {
  const selectors = [];

  // Priority order for automation
  if (element.ariaLabel) selectors.push(`[aria-label="${element.ariaLabel}"]`);
  if (element.role) selectors.push(`[role="${element.role}"]`);
  if (element.placeholder)
    selectors.push(`[placeholder="${element.placeholder}"]`);
  if (element.name) selectors.push(`[name="${element.name}"]`);
  if (element.id && !element.id.match(/[a-f0-9-]{20,}/))
    selectors.push(`#${element.id}`);
  if (element.title) selectors.push(`[title="${element.title}"]`);

  // Add structural selectors
  if (element.structural?.semantic) selectors.push(element.structural.semantic);
  if (element.structural?.relationship)
    selectors.push(element.structural.relationship);

  // Add all other selectors
  if (element.selectors) selectors.push(...element.selectors);
  if (element.xpath) selectors.push(`xpath:${element.xpath}`);
  if (element.cssPath) selectors.push(element.cssPath);

  // Remove duplicates
  return [...new Set(selectors)];
}

function generateFallbackMethods(element) {
  return [
    { method: "css_selector", priority: 1 },
    { method: "xpath", priority: 2 },
    { method: "text_content", priority: 3 },
    { method: "coordinates", priority: 4 },
    { method: "fuzzy_match", priority: 5 },
  ];
}

function inferElementPurpose(element) {
  const text = (element.text || "").toLowerCase();
  const label = (element.ariaLabel || element.placeholder || "").toLowerCase();
  const combined = text + " " + label;

  if (
    combined.includes("submit") ||
    combined.includes("send") ||
    combined.includes("go")
  )
    return "submit";
  if (combined.includes("search")) return "search";
  if (combined.includes("login") || combined.includes("sign in"))
    return "login";
  if (combined.includes("register") || combined.includes("sign up"))
    return "register";
  if (combined.includes("close") || combined.includes("cancel")) return "close";
  if (combined.includes("delete") || combined.includes("remove"))
    return "delete";
  if (combined.includes("edit")) return "edit";
  if (combined.includes("save")) return "save";
  if (combined.includes("next")) return "next";
  if (combined.includes("previous") || combined.includes("back"))
    return "previous";
  if (element.tag === "input" && element.type === "email") return "email_input";
  if (element.tag === "input" && element.type === "password")
    return "password_input";

  return "unknown";
}

function getElementTypeCounts(elements) {
  const counts = {};
  elements.forEach((e) => {
    const category = e.automationMeta?.category || "unknown";
    counts[category] = (counts[category] || 0) + 1;
  });
  return counts;
}

function prepareAutomationContext(pageInfo, elements, userIntent) {
  // Filter to most relevant elements
  const relevantElements = elements
    .filter((e) => e.automationMeta.isInteractive)
    .sort((a, b) => b.interactionScore - a.interactionScore)
    .slice(0, 30)
    .map((e) => ({
      id: e.automationMeta.id,
      category: e.automationMeta.category,
      description: e.automationMeta.description,
      purpose: e.automationMeta.semanticInfo.purpose,
      label: e.automationMeta.semanticInfo.label,
      actions: e.automationMeta.supportedActions,
      confidence: e.automationMeta.confidence,
      position: e.boundingBox,
    }));

  return {
    page: {
      url: pageInfo.url,
      totalElements: elements.length,
      interactiveElements: elements.filter(
        (e) => e.automationMeta.isInteractive
      ).length,
    },
    userIntent,
    availableElements: relevantElements,
  };
}

async function callLLM(context, provider, apiKey) {
  const systemPrompt = `You are an expert web automation engineer. Your task is to analyze webpage elements and create automation plans.

Given:
1. User's intent (what they want to do)
2. Available interactive elements with descriptions and supported actions
3. Page context

Create a detailed automation plan with:
1. Step-by-step actions
2. Element IDs to interact with
3. Action type (click, type, select, etc.)
4. Values to input (if applicable)
5. Verification steps
6. Fallback options

Respond in JSON format:
{
  "analysis": "Brief analysis of user intent",
  "steps": [
    {
      "stepNumber": 1,
      "action": "click" | "type" | "select" | "wait" | "verify",
      "elementId": "elem_123",
      "elementDescription": "Send button",
      "value": "optional value for type/select actions",
      "reasoning": "Why this element and action",
      "fallbackElementId": "elem_456",
      "waitAfter": 1000
    }
  ],
  "expectedOutcome": "What should happen",
  "riskLevel": "low" | "medium" | "high",
  "estimatedDuration": "seconds"
}`;

  const userPrompt = `Page URL: ${context.page.url}
Total Elements: ${context.page.totalElements}
Interactive Elements: ${context.page.interactiveElements}

User Intent: "${context.userIntent}"

Available Interactive Elements:
${JSON.stringify(context.availableElements, null, 2)}

Generate an automation plan to fulfill the user's intent.`;

  // Call OpenAI or Claude
  let response;
  if (provider === "openai") {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey || process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4-turbo-preview",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.3,
      }),
    });
  } else {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey || process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        temperature: 0.3,
      }),
    });
  }

  const data = await response.json();

  if (provider === "openai") {
    return JSON.parse(data.choices[0].message.content);
  } else {
    const content = data.content.find((c) => c.type === "text")?.text || "{}";
    return JSON.parse(content);
  }
}

function generateAutomationCode(plan, url) {
  const code = `
// Auto-generated Puppeteer automation code
// Generated at: ${new Date().toISOString()}
// Target URL: ${url}
// User Intent: ${plan.analysis}

const puppeteer = require('puppeteer');

async function runAutomation() {
  const browser = await puppeteer.launch({ 
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    console.log('Navigating to ${url}...');
    await page.goto('${url}', { waitUntil: 'networkidle2' });
    await page.waitForTimeout(2000);
    
${plan.steps.map((step, idx) => generateStepCode(step, idx)).join("\n")}
    
    console.log('✓ Automation completed successfully!');
    console.log('Expected outcome: ${plan.expectedOutcome}');
    
    // Wait to see results
    await page.waitForTimeout(3000);
    
    return { success: true, message: 'Automation completed' };
    
  } catch (error) {
    console.error('✗ Automation failed:', error.message);
    await page.screenshot({ path: 'error_screenshot.png' });
    return { success: false, error: error.message };
  } finally {
    await browser.close();
  }
}

// Run the automation
runAutomation()
  .then(result => console.log('Result:', result))
  .catch(error => console.error('Error:', error));

module.exports = { runAutomation };
`;

  return code;
}

function generateStepCode(step, index) {
  const element = step.elementId;
  let code = `\n    // Step ${step.stepNumber}: ${step.action} - ${step.elementDescription}`;
  code += `\n    console.log('Step ${step.stepNumber}: ${step.reasoning}');`;

  switch (step.action) {
    case "click":
      code += `\n    try {
      const element_${index} = await findElement(page, '${element}');
      await element_${index}.click();
      console.log('✓ Clicked: ${step.elementDescription}');
    } catch (error) {
      console.log('⚠ Primary click failed, trying fallback...');
      const fallback_${index} = await findElement(page, '${step.fallbackElementId}');
      await fallback_${index}.click();
    }`;
      break;

    case "type":
      code += `\n    const input_${index} = await findElement(page, '${element}');
    await input_${index}.click();
    await input_${index}.type('${step.value}', { delay: 100 });
    console.log('✓ Typed into: ${step.elementDescription}');`;
      break;

    case "select":
      code += `\n    const select_${index} = await findElement(page, '${element}');
    await select_${index}.select('${step.value}');
    console.log('✓ Selected: ${step.value}');`;
      break;

    case "wait":
      code += `\n    await page.waitForTimeout(${step.value || 1000});
    console.log('✓ Waited ${step.value || 1000}ms');`;
      break;

    case "verify":
      code += `\n    const exists_${index} = await page.$('${element}');
    if (!exists_${index}) throw new Error('Verification failed: ${step.elementDescription} not found');
    console.log('✓ Verified: ${step.elementDescription}');`;
      break;
  }

  if (step.waitAfter) {
    code += `\n    await page.waitForTimeout(${step.waitAfter});`;
  }

  return code;
}

async function executeAutomation(plan, url, elements, dryRun = false) {
  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      steps: plan.steps.map((s) => ({
        step: s.stepNumber,
        action: s.action,
        element: s.elementDescription,
        status: "simulated",
      })),
    };
  }

  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  const results = [];

  try {
    await page.goto(url, { waitUntil: "networkidle2" });
    await page.waitForTimeout(2000);

    for (const step of plan.steps) {
      try {
        const element = elements.find(
          (e) => e.automationMeta.id === step.elementId
        );
        if (!element) {
          throw new Error(`Element ${step.elementId} not found`);
        }

        const selector = element.automationMeta.primarySelector;

        switch (step.action) {
          case "click":
            await page.click(selector);
            break;
          case "type":
            await page.type(selector, step.value);
            break;
          case "select":
            await page.select(selector, step.value);
            break;
          case "wait":
            await page.waitForTimeout(step.value || 1000);
            break;
        }

        results.push({
          step: step.stepNumber,
          action: step.action,
          status: "success",
          element: step.elementDescription,
        });

        if (step.waitAfter) {
          await page.waitForTimeout(step.waitAfter);
        }
      } catch (error) {
        results.push({
          step: step.stepNumber,
          action: step.action,
          status: "failed",
          error: error.message,
        });
      }
    }

    const screenshot = await page.screenshot({ encoding: "base64" });

    await browser.close();

    return {
      success: true,
      steps: results,
      screenshot,
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function saveToFile(pageId, data) {
  const dir = path.join(__dirname, "stored_pages");
  await fs.mkdir(dir, { recursive: true });

  const filePath = path.join(dir, `${pageId}.json`);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));

  console.log(`[SAVE] Saved to ${filePath}`);
}

async function loadFromFile(pageId) {
  const filePath = path.join(__dirname, "stored_pages", `${pageId}.json`);
  const data = await fs.readFile(filePath, "utf-8");
  return JSON.parse(data);
}

// Helper function for finding elements (add to generated code)
const helperFunctions = `
// Helper function to find element with multiple strategies
async function findElement(page, elementId) {
  // This would use the stored selector strategies
  const selectors = ['[aria-label="..."]', '#id', '.class'];
  
  for (const selector of selectors) {
    try {
      const element = await page.$(selector);
      if (element) return element;
    } catch (e) {
      continue;
    }
  }
  
  throw new Error('Element not found with any strategy');
}
`;

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║  🤖 Web Automation System - RUNNING                           ║
╠═══════════════════════════════════════════════════════════════╣
║  📍 Server: http://localhost:${PORT}                              ║
║                                                               ║
║  ENDPOINTS:                                                   ║
║  1. POST /api/extract           - Extract & store elements   ║
║  2. GET  /api/pages             - List all pages             ║
║  3. GET  /api/pages/:id         - Get page info              ║
║  4. GET  /api/pages/:id/elements- Get stored elements        ║
║  5. POST /api/generate-automation - Generate automation plan ║
║  6. POST /api/execute           - Execute automation         ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
