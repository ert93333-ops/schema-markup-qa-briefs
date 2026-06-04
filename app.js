(function () {
  "use strict";

  const ANALYTICS_KEY = "schemaqa_analytics_events";
  const INTENT_KEY = "schemaqa_purchase_intents";
  const GITHUB_ISSUE_URL = "https://github.com/ert93333-ops/schema-markup-qa-briefs/issues/new";

  const SAMPLE_SCHEMA = [
    '<script type="application/ld+json">',
    "{",
    '  "@context": "https://schema.org",',
    '  "@type": "Product",',
    '  "name": "Launch Kit Basic",',
    '  "image": "https://example.com/images/launch-kit.jpg",',
    '  "description": "A launch checklist template for small teams.",',
    '  "sku": "LK-BASIC",',
    '  "offers": {',
    '    "@type": "Offer",',
    '    "url": "https://example.com/products/launch-kit-pro",',
    '    "price": "49",',
    '    "availability": "https://schema.org/InStock"',
    "  }",
    "}",
    "</script>",
  ].join("\n");

  const FIELD_RULES = {
    Product: {
      required: ["name"],
      oneOf: [["offers", "review", "aggregateRating"]],
      recommended: ["image", "description", "sku", "brand"],
      nested: { offers: ["price", "priceCurrency", "availability", "url"] },
    },
    Article: {
      required: ["headline", "author", "datePublished"],
      recommended: ["image", "dateModified", "publisher"],
      nested: {},
    },
    Organization: {
      required: ["name", "url"],
      recommended: ["logo", "sameAs"],
      nested: {},
    },
    BreadcrumbList: {
      required: ["itemListElement"],
      recommended: [],
      nested: {},
    },
    FAQPage: {
      required: ["mainEntity"],
      recommended: [],
      nested: {},
    },
  };

  const state = {
    latestBrief: null,
    latestBriefText: "",
    lastRemoteBody: "",
    signupStarted: false,
    pricingTracked: false,
  };

  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qsa(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  }

  function setText(selector, value) {
    const element = qs(selector);
    if (element) element.textContent = value;
  }

  function readArray(key) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    } catch (error) {
      return [];
    }
  }

  function writeArray(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      // Local storage can be unavailable in privacy modes. The UI still works.
    }
  }

  function getUtm() {
    const params = new URLSearchParams(window.location.search);
    return {
      utm_source: params.get("utm_source") || "",
      utm_medium: params.get("utm_medium") || "",
      utm_campaign: params.get("utm_campaign") || "",
      utm_content: params.get("utm_content") || "",
    };
  }

  function track(eventName, detail) {
    const events = readArray(ANALYTICS_KEY);
    events.push({
      event: eventName,
      detail: detail || {},
      utm: getUtm(),
      path: window.location.pathname,
      createdAt: new Date().toISOString(),
    });
    writeArray(ANALYTICS_KEY, events.slice(-200));
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function listHtml(items, emptyText) {
    if (!items.length) return "<p>" + escapeHtml(emptyText) + "</p>";
    return "<ul>" + items.map(function (item) {
      return "<li>" + escapeHtml(item) + "</li>";
    }).join("") + "</ul>";
  }

  function clean(value) {
    return String(value || "").trim();
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [value];
  }

  function hasValue(object, key) {
    return object && Object.prototype.hasOwnProperty.call(object, key) && clean(object[key]).length > 0;
  }

  function flattenNodes(value, nodes) {
    if (!value || typeof value !== "object") return nodes;
    if (Array.isArray(value)) {
      value.forEach(function (item) { flattenNodes(item, nodes); });
      return nodes;
    }
    if (value["@graph"] && Array.isArray(value["@graph"])) {
      value["@graph"].forEach(function (item) { flattenNodes(item, nodes); });
    }
    nodes.push(value);
    Object.keys(value).forEach(function (key) {
      if (key !== "@graph" && value[key] && typeof value[key] === "object") {
        flattenNodes(value[key], nodes);
      }
    });
    return nodes;
  }

  function extractJsonLdBlocks(raw) {
    const text = clean(raw);
    const blocks = [];
    const scriptRegex = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptRegex.exec(text))) {
      blocks.push(match[1].trim());
    }
    if (!blocks.length && text) blocks.push(text);
    return blocks;
  }

  function parseJsonLd(raw) {
    const blocks = extractJsonLdBlocks(raw);
    const parsed = [];
    const syntaxWarnings = [];

    blocks.forEach(function (block, index) {
      try {
        parsed.push(JSON.parse(block));
      } catch (error) {
        syntaxWarnings.push("Block " + (index + 1) + " is not valid JSON: " + error.message + ".");
      }
    });

    const nodes = [];
    parsed.forEach(function (item) { flattenNodes(item, nodes); });
    return { blocks: blocks, parsed: parsed, nodes: nodes, syntaxWarnings: syntaxWarnings };
  }

  function nodeTypes(node) {
    const type = node ? node["@type"] : "";
    if (Array.isArray(type)) return type.map(String);
    return type ? [String(type)] : [];
  }

  function nodeLabel(node) {
    return clean(node.name || node.headline || node["@id"] || node.url || node["@type"] || "Unnamed entity");
  }

  function visibleContains(summary, value) {
    const needle = clean(value).toLowerCase();
    if (!needle || needle.length < 3) return true;
    return clean(summary).toLowerCase().includes(needle.toLowerCase());
  }

  function analyzeSchema(input) {
    const schemaInput = clean(input.schemaInput);
    const visibleSummary = clean(input.visibleSummary);
    const intendedType = clean(input.schemaType);
    const pageUrl = clean(input.pageUrl);
    const indexabilityNotes = clean(input.indexabilityNotes);
    const templateOwner = clean(input.templateOwner);
    const parsed = parseJsonLd(schemaInput);
    const syntaxWarnings = parsed.syntaxWarnings.slice();
    const detectedTypes = [];
    const requiredWarnings = [];
    const recommendedWarnings = [];
    const contentMismatchWarnings = [];
    const duplicateWarnings = [];
    const urlImageChecks = [];
    const richResultReminders = [];
    const nextSteps = [
      "Run the final code or URL through Google's Rich Results Test before publishing.",
      "Confirm the production page is crawlable, indexable, and not behind login.",
      "Retest after CMS, theme, pricing, or frontend template changes.",
      "Treat this brief as QA guidance, not an official validation result or appearance guarantee.",
    ];

    parsed.nodes.forEach(function (node) {
      nodeTypes(node).forEach(function (type) {
        if (!detectedTypes.includes(type)) detectedTypes.push(type);
      });
    });

    if (!parsed.blocks.length) {
      syntaxWarnings.push("No JSON-LD block was provided.");
    }
    if (!parsed.nodes.length && !syntaxWarnings.length) {
      syntaxWarnings.push("No structured-data entities were detected.");
    }
    if (parsed.blocks.length > 1) {
      duplicateWarnings.push(parsed.blocks.length + " JSON-LD blocks detected; confirm this is intentional and not template duplication.");
    }

    const rules = FIELD_RULES[intendedType] || null;
    const matchingNodes = intendedType === "Generic"
      ? parsed.nodes
      : parsed.nodes.filter(function (node) { return nodeTypes(node).includes(intendedType); });

    if (intendedType !== "Generic" && !matchingNodes.length) {
      requiredWarnings.push("No @" + "type " + intendedType + " entity was detected even though that is the intended schema type.");
    }

    const checkNodes = matchingNodes.length ? matchingNodes : parsed.nodes.slice(0, 2);
    checkNodes.forEach(function (node) {
      if (!node["@context"]) {
        recommendedWarnings.push(nodeLabel(node) + " is missing @context.");
      }
      if (!node["@type"]) {
        requiredWarnings.push(nodeLabel(node) + " is missing @type.");
      }
      if (rules) {
        rules.required.forEach(function (field) {
          if (!hasValue(node, field)) {
            requiredWarnings.push(nodeLabel(node) + " is missing required field `" + field + "` for " + intendedType + " QA.");
          }
        });
        (rules.oneOf || []).forEach(function (group) {
          if (!group.some(function (field) { return hasValue(node, field); })) {
            requiredWarnings.push(nodeLabel(node) + " should include at least one of `" + group.join("`, `") + "`.");
          }
        });
        rules.recommended.forEach(function (field) {
          if (!hasValue(node, field)) {
            recommendedWarnings.push(nodeLabel(node) + " is missing recommended field `" + field + "`.");
          }
        });
        Object.keys(rules.nested || {}).forEach(function (parent) {
          const parentValues = node[parent] ? asArray(node[parent]) : [];
          if (!parentValues.length) return;
          parentValues.forEach(function (nested, nestedIndex) {
            if (!nested || typeof nested !== "object") return;
            rules.nested[parent].forEach(function (field) {
              if (!hasValue(nested, field)) {
                requiredWarnings.push(nodeLabel(node) + " has `" + parent + "` item " + (nestedIndex + 1) + " missing `" + field + "`.");
              }
            });
          });
        });
      }
      ["name", "headline"].forEach(function (field) {
        if (hasValue(node, field) && visibleSummary && !visibleContains(visibleSummary, node[field])) {
          contentMismatchWarnings.push("Visible-page summary does not mention `" + node[field] + "` from `" + field + "`.");
        }
      });
      if (hasValue(node, "description") && visibleSummary && !visibleContains(visibleSummary, String(node.description).slice(0, 18))) {
        contentMismatchWarnings.push("Description in JSON-LD may not match the visible-page summary.");
      }
      if (hasValue(node, "url") && pageUrl && clean(node.url).replace(/\/$/, "") !== pageUrl.replace(/\/$/, "")) {
        urlImageChecks.push("Entity URL `" + node.url + "` differs from the provided page URL `" + pageUrl + "`.");
      }
      if (hasValue(node, "image")) {
        asArray(node.image).forEach(function (imageValue) {
          if (typeof imageValue === "string" && !/^https?:\/\//i.test(imageValue)) {
            urlImageChecks.push("Image value `" + imageValue + "` is not an absolute HTTP(S) URL.");
          }
        });
      }
      if (node.offers) {
        asArray(node.offers).forEach(function (offer) {
          if (offer && typeof offer === "object") {
            if (hasValue(offer, "price") && visibleSummary && !visibleContains(visibleSummary, offer.price)) {
              contentMismatchWarnings.push("Offer price `" + offer.price + "` is not mentioned in the visible-page summary.");
            }
            if (hasValue(offer, "url") && pageUrl && clean(offer.url).replace(/\/$/, "") !== pageUrl.replace(/\/$/, "")) {
              urlImageChecks.push("Offer URL `" + offer.url + "` differs from the provided page URL.");
            }
          }
        });
      }
    });

    const labelCounts = {};
    parsed.nodes.forEach(function (node) {
      const label = nodeLabel(node);
      labelCounts[label] = (labelCounts[label] || 0) + 1;
    });
    Object.keys(labelCounts).forEach(function (label) {
      if (labelCounts[label] > 1 && label !== "Unnamed entity") {
        duplicateWarnings.push("Entity label `" + label + "` appears " + labelCounts[label] + " times; confirm duplicates are intentional.");
      }
    });

    if (!visibleSummary) {
      contentMismatchWarnings.push("No visible-page summary was provided, so JSON-LD cannot be compared to page content.");
    }
    if (/behind login|staging/i.test(indexabilityNotes)) {
      richResultReminders.push("Indexability notes indicate the page may be gated or staging-only; official rich-result tests may not access it.");
    }
    if (/not yet checked/i.test(indexabilityNotes)) {
      richResultReminders.push("Indexability has not been checked; verify robots.txt, noindex, canonical, and login requirements before publishing.");
    }
    richResultReminders.push("Google can use structured data for eligibility, but rich-result appearance is not guaranteed.");
    richResultReminders.push("Use Schema.org or Google testing tools for final validation after this pre-publish QA.");

    const issueCount = syntaxWarnings.length + requiredWarnings.length + contentMismatchWarnings.length + duplicateWarnings.length + urlImageChecks.length + richResultReminders.filter(function (item) {
      return /gated|not been checked|staging/i.test(item);
    }).length;
    const status = syntaxWarnings.length || requiredWarnings.length
      ? "Fix before publish"
      : issueCount >= 3
        ? "Manual review"
        : "Ready for official test";

    return {
      status: status,
      issueCount: issueCount,
      intendedType: intendedType,
      pageUrl: pageUrl,
      indexabilityNotes: indexabilityNotes,
      templateOwner: templateOwner,
      blockCount: parsed.blocks.length,
      entityCount: parsed.nodes.length,
      detectedTypes: detectedTypes,
      syntaxWarnings: Array.from(new Set(syntaxWarnings)),
      requiredWarnings: Array.from(new Set(requiredWarnings)),
      recommendedWarnings: Array.from(new Set(recommendedWarnings)),
      contentMismatchWarnings: Array.from(new Set(contentMismatchWarnings)),
      duplicateWarnings: Array.from(new Set(duplicateWarnings)),
      urlImageChecks: Array.from(new Set(urlImageChecks)),
      richResultReminders: Array.from(new Set(richResultReminders)),
      nextSteps: nextSteps,
    };
  }

  function briefToText(brief) {
    return [
      "Schema Markup QA Briefs",
      "Status: " + brief.status,
      "Issue count: " + brief.issueCount,
      "Intended type: " + brief.intendedType,
      "Page URL: " + brief.pageUrl,
      "Template owner: " + brief.templateOwner,
      "Detected types: " + (brief.detectedTypes.length ? brief.detectedTypes.join(", ") : "none"),
      "JSON-LD blocks: " + brief.blockCount,
      "Entities detected: " + brief.entityCount,
      "",
      "Syntax warnings:",
      brief.syntaxWarnings.length ? brief.syntaxWarnings.join("\n") : "None found.",
      "",
      "Required-field warnings:",
      brief.requiredWarnings.length ? brief.requiredWarnings.join("\n") : "None found.",
      "",
      "Recommended-field warnings:",
      brief.recommendedWarnings.length ? brief.recommendedWarnings.join("\n") : "None found.",
      "",
      "Visible-content mismatch warnings:",
      brief.contentMismatchWarnings.length ? brief.contentMismatchWarnings.join("\n") : "None found.",
      "",
      "Duplicate and URL/image checks:",
      brief.duplicateWarnings.concat(brief.urlImageChecks).length ? brief.duplicateWarnings.concat(brief.urlImageChecks).join("\n") : "None found.",
      "",
      "Rich Results Test reminders:",
      brief.richResultReminders.join("\n"),
      "",
      "Next steps:",
      brief.nextSteps.join("\n"),
    ].join("\n");
  }

  function renderBrief(brief) {
    const output = qs("#brief-output");
    const copyButton = qs("#copy-brief");
    const outputPanel = qs(".output-panel");
    const statusPill = qs("#status-pill");
    if (!output) return;

    output.classList.remove("empty");
    output.classList.add("is-updated");
    window.setTimeout(function () { output.classList.remove("is-updated"); }, 480);
    output.innerHTML = [
      '<div class="brief-summary">',
      '<strong>' + escapeHtml(brief.status) + '</strong>',
      '<span>' + brief.issueCount + ' checks need attention across ' + brief.entityCount + ' detected entities</span>',
      "</div>",
      '<section class="brief-section"><h4>Detected schema types</h4>' + listHtml(brief.detectedTypes, "No schema types detected.") + "</section>",
      '<section class="brief-section"><h4>Syntax warnings</h4>' + listHtml(brief.syntaxWarnings, "No JSON syntax warnings found.") + "</section>",
      '<section class="brief-section"><h4>Required-field warnings</h4>' + listHtml(brief.requiredWarnings, "No required-field warnings found.") + "</section>",
      '<section class="brief-section"><h4>Recommended-field warnings</h4>' + listHtml(brief.recommendedWarnings, "No recommended-field warnings found.") + "</section>",
      '<section class="brief-section"><h4>Visible-content mismatch warnings</h4>' + listHtml(brief.contentMismatchWarnings, "No visible-content mismatch warnings found.") + "</section>",
      '<section class="brief-section"><h4>Duplicate and URL/image checks</h4>' + listHtml(brief.duplicateWarnings.concat(brief.urlImageChecks), "No duplicate or URL/image checks triggered.") + "</section>",
      '<section class="brief-section"><h4>Rich Results Test reminders</h4>' + listHtml(brief.richResultReminders, "No reminders found.") + "</section>",
      '<section class="brief-section"><h4>Next steps</h4>' + listHtml(brief.nextSteps, "No next steps found.") + "</section>",
    ].join("");
    setText("#output-title", "Schema markup QA brief ready");
    setText("#status-pill", brief.status);
    if (copyButton) copyButton.disabled = false;
    if (outputPanel) {
      outputPanel.classList.add("has-brief");
      outputPanel.classList.toggle("status-good", brief.status === "Ready for official test");
      outputPanel.classList.toggle("status-warning", brief.status === "Manual review");
      outputPanel.classList.toggle("status-danger", brief.status === "Fix before publish");
    }
    if (statusPill) {
      statusPill.classList.toggle("status-good", brief.status === "Ready for official test");
      statusPill.classList.toggle("status-warning", brief.status === "Manual review");
      statusPill.classList.toggle("status-danger", brief.status === "Fix before publish");
    }
    state.latestBrief = brief;
    state.latestBriefText = briefToText(brief);
  }

  function pulseClass(element, className, duration) {
    if (!element) return;
    element.classList.add(className);
    window.setTimeout(function () { element.classList.remove(className); }, duration || 600);
  }

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (error) {
        // Fall through to textarea fallback for headless browser clipboard blocks.
      }
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  function setupAuditor() {
    const form = qs("#auditor-form");
    const schemaInput = qs("#schema-input");
    const visibleSummary = qs("#visible-summary");
    const loadSample = qs("#load-sample");
    const error = qs("#workflow-error");
    const copyButton = qs("#copy-brief");
    if (!form || !schemaInput) return;

    if (loadSample) {
      loadSample.addEventListener("click", function () {
        schemaInput.value = SAMPLE_SCHEMA;
        if (visibleSummary) visibleSummary.value = "Visible page copy says: Launch Kit Pro is available for $49 and is in stock. It includes launch checklist templates for small teams.";
        if (qs("#schema-type")) qs("#schema-type").value = "Product";
        if (qs("#page-url")) qs("#page-url").value = "https://example.com/products/launch-kit-pro";
        schemaInput.focus();
        pulseClass(loadSample, "is-confirmed", 520);
        track("sample_schema_loaded");
      });
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      track("core_action_started", { triggerSource: "auditor_form" });
      if (error) error.textContent = "";

      const input = {
        schemaInput: schemaInput.value.trim(),
        visibleSummary: visibleSummary ? visibleSummary.value.trim() : "",
        schemaType: qs("#schema-type") ? qs("#schema-type").value : "Generic",
        pageUrl: qs("#page-url") ? qs("#page-url").value.trim() : "",
        indexabilityNotes: qs("#indexability-notes") ? qs("#indexability-notes").value : "",
        templateOwner: qs("#template-owner") ? qs("#template-owner").value.trim() : "",
      };
      const inputLength = Object.keys(input).reduce(function (total, key) { return total + String(input[key]).length; }, 0);
      if (!input.schemaInput) {
        if (error) error.textContent = "Paste JSON-LD or load the sample before generating a schema QA brief.";
        track("core_action_failed", { reason: "empty_input" });
        return;
      }

      const brief = analyzeSchema(input);
      renderBrief(brief);
      track("core_action_completed", {
        issueCount: brief.issueCount,
        status: brief.status,
        intendedType: brief.intendedType,
        entityCount: brief.entityCount,
        inputLength: inputLength,
      });
    });

    if (copyButton) {
      copyButton.addEventListener("click", function () {
        if (!state.latestBriefText) return;
        copyText(state.latestBriefText).then(function () {
          copyButton.textContent = "Copied brief";
          pulseClass(copyButton, "is-confirmed", 700);
          track("brief_copied", { issueCount: state.latestBrief ? state.latestBrief.issueCount : 0 });
          window.setTimeout(function () { copyButton.textContent = "Copy brief"; }, 1400);
        });
      });
    }
  }

  function buildRemoteIssue(intent) {
    const body = [
      "Schema Markup QA Briefs early-access request",
      "",
      "Role: " + intent.role,
      "Number of sites: " + intent.siteCount,
      "Main schema type: " + intent.mainSchemaType,
      "Plan interest: " + intent.plan,
      "Willingness to pay: " + intent.budget,
      "Purchase intent: " + (intent.purchaseIntent ? "yes" : "no"),
      "",
      "Biggest schema markup pain:",
      intent.pain,
      "",
      "Note: Email is intentionally omitted from this public issue body.",
    ].join("\n");
    state.lastRemoteBody = body;
    const params = new URLSearchParams({
      title: "Schema Markup QA Briefs early-access request",
      body: body,
      labels: "early-access,purchase-intent,demo-request",
      template: "demo_request.md",
    });
    return GITHUB_ISSUE_URL + "?" + params.toString();
  }

  function setupWaitlist() {
    const form = qs("#waitlist-form");
    const status = qs("#waitlist-status");
    const handoff = qs("#handoff-panel");
    const remoteLink = qs("#remote-intent-link");
    const copyRequest = qs("#copy-request");
    const planSelect = qs("#plan");
    if (!form) return;

    form.addEventListener("focusin", function () {
      if (!state.signupStarted) {
        state.signupStarted = true;
        track("signup_started", { triggerSource: "waitlist_form" });
      }
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (!state.signupStarted) {
        state.signupStarted = true;
        track("signup_started", { triggerSource: "waitlist_submit" });
      }
      const intent = {
        email: qs("#email") ? qs("#email").value.trim() : "",
        role: qs("#role") ? qs("#role").value : "",
        siteCount: qs("#site-count") ? qs("#site-count").value : "",
        mainSchemaType: qs("#main-schema-type") ? qs("#main-schema-type").value : "",
        plan: planSelect ? planSelect.value : "",
        budget: qs("#budget") ? qs("#budget").value : "",
        pain: qs("#pain") ? qs("#pain").value.trim() : "",
        purchaseIntent: qs("#purchase-intent") ? qs("#purchase-intent").checked : false,
        createdAt: new Date().toISOString(),
        utm: getUtm(),
      };
      const intents = readArray(INTENT_KEY);
      intents.push(intent);
      writeArray(INTENT_KEY, intents.slice(-100));

      const remoteHref = buildRemoteIssue(intent);
      if (remoteLink) remoteLink.href = remoteHref;
      if (handoff) {
        handoff.hidden = false;
        pulseClass(handoff, "is-confirmed", 700);
      }
      if (status) status.textContent = "You are on the early access list. Public-safe request details are ready.";

      track("waitlist_submitted", { role: intent.role, plan: intent.plan, siteCount: intent.siteCount });
      track("feedback_submitted", { triggerSource: "waitlist_form", painLength: intent.pain.length });
      track("remote_intent_ready", { hasRemoteLink: Boolean(remoteHref) });
      if (intent.purchaseIntent) track("checkout_intent", { plan: intent.plan, budget: intent.budget });
    });

    if (copyRequest) {
      copyRequest.addEventListener("click", function () {
        if (!state.lastRemoteBody) return;
        copyText(state.lastRemoteBody).then(function () {
          copyRequest.textContent = "Copied request details";
          pulseClass(copyRequest, "is-confirmed", 700);
          track("remote_intent_copied", { bodyLength: state.lastRemoteBody.length });
          window.setTimeout(function () { copyRequest.textContent = "Copy request details"; }, 1500);
        });
      });
    }
  }

  function setupPlanButtons() {
    const waitlist = qs("#waitlist");
    const planSelect = qs("#plan");
    qsa(".plan-button").forEach(function (button) {
      button.addEventListener("click", function () {
        const plan = button.getAttribute("data-plan") || "";
        if (planSelect && plan) planSelect.value = plan;
        track("pricing_viewed", { triggerSource: "plan_button" });
        state.pricingTracked = true;
        track("checkout_started", { plan: plan, triggerSource: "pricing_button" });
        pulseClass(button, "is-confirmed", 500);
        if (waitlist) waitlist.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  function setupTracking() {
    track("landing_viewed", { product: "Schema Markup QA Briefs" });
    qsa("[data-track-cta]").forEach(function (element) {
      element.addEventListener("click", function () {
        track("cta_clicked", { cta: element.getAttribute("data-track-cta") || element.textContent.trim() });
      });
    });
    const pricing = qs("#pricing");
    if (pricing && "IntersectionObserver" in window) {
      const observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting && !state.pricingTracked) {
            state.pricingTracked = true;
            track("pricing_viewed", { triggerSource: "scroll" });
            observer.disconnect();
          }
        });
      }, { threshold: 0.35 });
      observer.observe(pricing);
    }
  }

  function setupChrome() {
    const header = qs("[data-header]");
    if (!header) return;
    function updateHeader() {
      header.classList.toggle("is-scrolled", window.scrollY > 8);
    }
    updateHeader();
    window.addEventListener("scroll", updateHeader, { passive: true });
  }

  function setupReveal() {
    const elements = qsa(".reveal");
    if (!("IntersectionObserver" in window)) {
      elements.forEach(function (element) { element.classList.add("is-visible"); });
      return;
    }
    const observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    elements.forEach(function (element) { observer.observe(element); });
  }

  document.addEventListener("DOMContentLoaded", function () {
    setupTracking();
    setupChrome();
    setupReveal();
    setupAuditor();
    setupWaitlist();
    setupPlanButtons();
  });
}());
