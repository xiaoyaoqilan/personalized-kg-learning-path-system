const STORAGE_KEY = "learnpath_records_v5";

const navItems = [
  ["start", "目标"],
  ["library", "材料"],
  ["analysis", "分析"],
  ["quiz", "诊断"],
  ["plan", "路线"],
  ["practice", "练习"],
  ["assistant", "助教"],
];

const learningStyles = [
  { id: "questions", label: "多做题", prompt: "用题目诊断和巩固" },
  { id: "examples", label: "看例子", prompt: "用例子解释抽象概念" },
  { id: "structure", label: "先搭框架", prompt: "先建立知识结构再深入细节" },
  { id: "review", label: "需要复习提醒", prompt: "把复习和回顾放进路线" },
  { id: "slow", label: "讲慢一点", prompt: "降低推进速度，先补基础" },
  { id: "project", label: "边做边学", prompt: "用小任务带动学习" },
];

const state = {
  selectedStyles: new Set(["questions", "structure", "review"]),
  profile: {},
  source: null,
  graph: null,
  goal: null,
  questions: [],
  answers: [],
  currentQuestion: 0,
  weakPoints: [],
  seenQuestions: new Set(),
  practiceMeta: null,
  plan: null,
  sessionId: null,
};

const $ = (selector) => document.querySelector(selector);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function init() {
  renderNav();
  renderStyleChoices();
  bindEvents();
  loadStatus();
  go(location.hash?.slice(1) || "start");
  renderRecentRecords();
}

function bindEvents() {
  $("#toLibraryBtn").addEventListener("click", () => {
    state.profile = collectProfile();
    if (!state.profile.goal) return shake("#goalInput");
    state.sessionId = `session_${Date.now()}`;
    saveRecord("已填写目标");
    go("library");
  });

  $("#indexBtn").addEventListener("click", indexSource);
  $("#analyzeBtn").addEventListener("click", startAnalysis);
  $("#startQuizBtn").addEventListener("click", () => go("quiz"));
  $("#practiceBtn").addEventListener("click", () => {
    go("practice");
    renderLearnerState();
    drawPracticeQuestion();
  });
  $("#drawQuestionBtn").addEventListener("click", drawPracticeQuestion);
  $("#askBtn").addEventListener("click", () => go("assistant"));
  $("#ragBtn").addEventListener("click", askAssistant);
}

function renderNav() {
  $("#nav").innerHTML = navItems.map(([id, label], index) => `
    <button type="button" data-nav="${id}">
      <span>${index + 1}</span>
      ${label}
    </button>
  `).join("");

  $("#nav").querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => go(button.dataset.nav));
  });
}

function go(view) {
  const known = navItems.some(([id]) => id === view) ? view : "start";
  document.querySelectorAll(".view").forEach((item) => {
    item.classList.toggle("hidden", item.dataset.view !== known);
  });
  document.querySelectorAll("[data-nav]").forEach((item) => {
    item.classList.toggle("active", item.dataset.nav === known);
  });
  history.replaceState(null, "", `#${known}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function loadStatus() {
  try {
    await requestJson("/api/status");
  } catch {
    // The service badge is intentionally hidden from the learner-facing UI.
  }
}

function renderStyleChoices() {
  $("#styleChoices").innerHTML = learningStyles.map((style) => `
    <button type="button" class="choice ${state.selectedStyles.has(style.id) ? "selected" : ""}" data-style="${style.id}">
      ${style.label}
    </button>
  `).join("");

  $("#styleChoices").querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.style;
      if (state.selectedStyles.has(id) && state.selectedStyles.size === 1) return;
      state.selectedStyles.has(id) ? state.selectedStyles.delete(id) : state.selectedStyles.add(id);
      renderStyleChoices();
    });
  });
}

function collectProfile() {
  return {
    goal: $("#goalInput").value.trim(),
    grade: $("#gradeInput").value.trim() || "未填写",
    subject: $("#subjectInput").value.trim() || "未填写",
    preference: $("#preferenceInput").value.trim() || "未填写",
    problem: $("#problemInput").value.trim() || "未填写",
    styles: learningStyles
      .filter((item) => state.selectedStyles.has(item.id))
      .map((item) => item.prompt),
  };
}

async function indexSource() {
  const text = $("#sourceTextInput").value.trim();
  const title = $("#sourceTitleInput").value.trim() || state.profile.goal || "学习材料";
  if (!text) return shake("#sourceTextInput");

  $("#indexResult").innerHTML = loading("正在整理材料");
  const data = await requestJson("/api/index", { title, text, profile: state.profile });
  state.source = data.source;
  state.graph = data.graph;

  $("#indexResult").innerHTML = `
    <div><span>材料片段</span><strong>${data.source.chunkCount}</strong></div>
    <div><span>关键概念</span><strong>${data.graph.nodes.length}</strong></div>
    <div><span>概念关系</span><strong>${data.graph.edges.length}</strong></div>
  `;
  saveRecord("已整理材料");
}

async function startAnalysis() {
  state.profile = { ...state.profile, ...collectProfile() };
  if (!state.profile.goal) return go("start");

  go("analysis");
  $("#startQuizBtn").disabled = true;
  $("#analysisSummary").innerHTML = "";
  $("#analysisSteps").innerHTML = "";

  const steps = [
    ["读取学习档案", `目标：${state.profile.goal}`],
    ["整理已有材料", state.source ? `已读取 ${state.source.chunkCount} 段材料` : "未上传材料，先按目标生成诊断"],
    ["定位可能卡点", state.profile.problem === "未填写" ? "根据目标和偏好先做初步判断" : state.profile.problem],
    ["准备诊断题", "题目会覆盖基础、应用和迁移三个层次"],
  ];

  for (const [title, desc] of steps) {
    appendAnalysisStep(title, desc);
    await sleep(520);
  }

  const data = await requestJson("/api/diagnose", {
    profile: state.profile,
    source: state.source,
    graph: state.graph,
  });

  state.goal = {
    goalTitle: data.goalTitle || state.profile.goal,
    goalDescription: data.goalDescription || "先判断基础，再安排练习",
    problemGuess: data.problemGuess || "需要通过题目确认基础掌握情况",
  };
  state.questions = sanitizeQuestions(data.questions);
  state.answers = [];
  state.weakPoints = [];
  state.seenQuestions = new Set();
  state.currentQuestion = 0;

  $("#analysisSummary").innerHTML = `
    <div><span>当前判断</span><strong>${escapeHtml(state.goal.problemGuess)}</strong></div>
    <div><span>下一步</span><strong>先完成 ${state.questions.length} 道诊断题，再生成路线</strong></div>
    <div><span>材料状态</span><strong>${state.source ? `已整理 ${state.source.chunkCount} 段材料` : "未放入材料，使用目标进行判断"}</strong></div>
  `;
  renderKnowledgeMap("#analysisKnowledgeMap");

  renderQuestion();
  saveRecord("已完成分析");
  updateBadge(data);
  $("#startQuizBtn").disabled = false;
}

function appendAnalysisStep(title, desc) {
  const item = document.createElement("article");
  item.className = "demo-step";
  item.innerHTML = `<b>${escapeHtml(title)}</b><p>${escapeHtml(desc)}</p>`;
  $("#analysisSteps").appendChild(item);
}

function renderQuestion() {
  const question = state.questions[state.currentQuestion];
  rememberQuestion(question.question);
  $("#quizProgress").textContent = `${state.currentQuestion + 1} / ${state.questions.length}`;
  $("#quizArea").innerHTML = `
    <article class="question-card">
      <p>${escapeHtml(question.skill)}</p>
      <h2>${escapeHtml(question.question)}</h2>
      <div class="option-grid">
        ${question.options.map((option) => `<button type="button">${escapeHtml(option)}</button>`).join("")}
      </div>
    </article>
  `;

  $("#quizArea").querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => answerQuestion(button, question));
  });
}

function answerQuestion(button, question) {
  const buttons = [...button.closest(".option-grid").querySelectorAll("button")];
  buttons.forEach((item) => item.disabled = true);

  const selected = button.textContent.trim();
  const correct = selected === question.answer;
  button.classList.add(correct ? "correct" : "wrong");
  if (!correct) {
    const right = buttons.find((item) => item.textContent === question.answer);
    right?.classList.add("correct");
  }

  state.answers.push({
    skill: question.skill,
    correct,
    selected,
    answer: question.answer,
  });
  if (!correct) state.weakPoints.push(question.skill);
  $("#quizProgress").textContent = `${state.answers.length} / ${state.questions.length}`;
  saveRecord("诊断中");

  setTimeout(async () => {
    state.currentQuestion += 1;
    if (state.currentQuestion >= state.questions.length) await buildPlan();
    else renderQuestion();
  }, 760);
}

async function buildPlan() {
  go("plan");
  $("#profileSummary").innerHTML = loading("正在生成学习路线");
  $("#learningPath").innerHTML = "";

  const data = await requestJson("/api/plan", {
    profile: state.profile,
    goal: state.goal,
    answers: state.answers,
    weakPoints: state.weakPoints,
    graph: state.graph,
  });
  state.plan = data;

  const correctCount = state.answers.filter((item) => item.correct).length;
  const weakSkills = Array.isArray(data.weakSkills) ? data.weakSkills : unique(state.weakPoints);

  const displayScore = Number(data.score) > state.questions.length ? correctCount : (data.score ?? correctCount);
  $("#profileSummary").innerHTML = `
    <div><span>水平判断</span><strong>${escapeHtml(data.level || "需要继续观察")}</strong></div>
    <div><span>诊断结果</span><strong>${displayScore} / ${state.questions.length}</strong></div>
    <div><span>重点关注</span><strong>${weakSkills.length ? weakSkills.map(escapeHtml).join("、") : "暂未发现明显薄弱点"}</strong></div>
  `;
  renderKnowledgeMap("#knowledgeMap");

  $("#learningPath").innerHTML = (data.path || []).map((item, index) => `
    <li>
      <b>${index + 1}</b>
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        <p>${escapeHtml(item.desc)}</p>
      </div>
      <em>${escapeHtml(item.type || `${item.minutes || 20} 分钟`)}</em>
    </li>
  `).join("");

  saveRecord("已生成路线");
  updateWeaknessLog();
  updateBadge(data);
}

async function drawPracticeQuestion() {
  renderLearnerState();
  $("#practiceReason").innerHTML = "";
  $("#practiceQuestion").innerHTML = loading("正在抽取下一题");
  let data = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    data = await requestJson("/api/practice", {
      profile: state.profile,
      goal: state.goal,
      answers: state.answers,
      weakPoints: state.weakPoints,
      source: state.source,
      previousQuestions: [...state.seenQuestions],
    });
    const candidate = data.question || data;
    if (!state.seenQuestions.has(normalizeText(candidate.question))) break;
    data = {
      question: makeLocalVariantQuestion(candidate, attempt),
      source: "local-variant",
    };
    break;
  }

  state.practiceMeta = data;
  renderPracticeReason(data, data.question || data);
  renderPracticeQuestion(data.question || data);
  updateBadge(data);
}

function renderPracticeQuestion(question) {
  const item = sanitizeQuestions([question])[0];
  rememberQuestion(item.question);
  $("#practiceQuestion").innerHTML = `
    <article class="question-card">
      <p>${escapeHtml(item.skill)}</p>
      <h2>${escapeHtml(item.question)}</h2>
      <div class="option-grid">
        ${item.options.map((option) => `<button type="button">${escapeHtml(option)}</button>`).join("")}
      </div>
    </article>
  `;

  $("#practiceQuestion").querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const buttons = [...button.closest(".option-grid").querySelectorAll("button")];
      buttons.forEach((item) => item.disabled = true);
      const selected = button.textContent.trim();
      const correct = selected === item.answer;
      button.classList.add(correct ? "correct" : "wrong");
      if (!correct) {
        const right = buttons.find((option) => option.textContent === item.answer);
        right?.classList.add("correct");
        state.weakPoints.push(item.skill);
      }
      state.answers.push({ skill: item.skill, correct, selected, answer: item.answer });
      renderAnswerFeedback(item, correct, selected);
      updateWeaknessLog();
      renderKnowledgeMap("#knowledgeMap");
      renderLearnerState();
      saveRecord("练习中");
    });
  });
}

function renderLearnerState() {
  const el = $("#learnerStatePanel");
  if (!el) return;
  const latest = state.answers.at(-1);
  const weak = unique(state.weakPoints);
  const correctCount = state.answers.filter((item) => item.correct).length;
  const total = state.answers.length;
  el.innerHTML = `
    <div class="state-card main">
      <span>当前目标</span>
      <strong>${escapeHtml(state.profile.goal || state.goal?.goalTitle || "还没有填写目标")}</strong>
      <p>${escapeHtml(state.goal?.problemGuess || state.profile.problem || "系统会根据你的答题记录判断问题点。")}</p>
    </div>
    <div class="state-card">
      <span>已练习</span>
      <strong>${total ? `${correctCount} / ${total}` : "等待开始"}</strong>
      <p>${latest ? `最近一题：${latest.correct ? "答对" : "答错"}「${latest.skill}」` : "完成题目后这里会更新。"}</p>
    </div>
    <div class="state-card">
      <span>优先问题点</span>
      <strong>${weak.length ? escapeHtml(weak.slice(-3).join("、")) : "待诊断"}</strong>
      <p>${weak.length ? "下一题会优先围绕这些节点变化问法。" : "先完成诊断题，系统会记录薄弱节点。"}</p>
    </div>
  `;
}

function renderPracticeReason(data, question) {
  const reason = data.reason || data.focusReason || data.explanation || defaultPracticeReason(question);
  $("#practiceReason").innerHTML = `
    <article>
      <span>为什么抽这题</span>
      <strong>${escapeHtml(question.skill || "当前问题点")}</strong>
      <p>${escapeHtml(reason)}</p>
    </article>
  `;
}

function defaultPracticeReason(question) {
  const weak = unique(state.weakPoints);
  if (weak.includes(question.skill)) return `你在「${question.skill}」相关题目上出现过错误，所以系统继续换一种问法确认是否真正掌握。`;
  if (weak.length) return `系统正在围绕你的薄弱点「${weak.slice(-2).join("、")}」继续抽题，并观察是否能迁移到相近概念。`;
  return "这是根据当前学习目标生成的基础检查题，用来继续更新你的学习画像。";
}

function renderAnswerFeedback(question, correct, selected) {
  const message = correct
    ? `答对了。系统会把「${question.skill}」暂时标记为较稳定，但后续还会用变式题确认。`
    : `这题暴露了「${question.skill}」还不稳定。你选的是「${selected}」，正确答案是「${question.answer}」。`;
  $("#practiceReason").innerHTML += `
    <article class="answer-feedback ${correct ? "ok" : "warn"}">
      <span>本题反馈</span>
      <strong>${correct ? "掌握度上升" : "记录为问题点"}</strong>
      <p>${escapeHtml(message)}</p>
    </article>
  `;
}

async function askAssistant() {
  const question = $("#askInput").value.trim();
  if (!question) return shake("#askInput");

  $("#ragResult").innerHTML = loading("正在结合当前记录回答");
  const data = await requestJson("/api/rag", {
    question,
    profile: state.profile,
    weakPoints: state.weakPoints,
    source: state.source,
    graph: state.graph,
  });

  $("#ragResult").innerHTML = `
    <article>
      <h2>回答</h2>
      <p>${escapeHtml(data.answer)}</p>
    </article>
    <article>
      <h2>参考依据</h2>
      ${(data.citations || []).map((item) => `<p>${escapeHtml(item)}</p>`).join("") || "<p>当前没有可引用的材料片段。</p>"}
    </article>
  `;
  $("#graphBox").innerHTML = renderGraph(data.related || state.graph);
  updateBadge(data);
}

function renderGraph(graph) {
  if (!graph || !graph.nodes?.length) return "";
  return `
    <h2>相关概念</h2>
    <div class="graph-tags">
      ${graph.nodes.slice(0, 12).map((node) => `<span>${escapeHtml(node)}</span>`).join("")}
    </div>
  `;
}

function updateWeaknessLog() {
  const counts = state.weakPoints.reduce((acc, point) => {
    acc[point] = (acc[point] || 0) + 1;
    return acc;
  }, {});
  const items = Object.entries(counts);
  $("#weaknessLog").innerHTML = items.length
    ? `<h2>已记录的问题点</h2>${items.map(([name, count]) => `<span>${escapeHtml(name)} × ${count}</span>`).join("")}`
    : `<h2>已记录的问题点</h2><p>暂时没有明显薄弱点。</p>`;
}

function renderKnowledgeMap(selector) {
  const el = $(selector);
  if (!el) return;
  const nodes = buildKnowledgeNodes();
  if (!nodes.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <div class="section-head">
      <h2>个人知识节点</h2>
      <p>根据材料、诊断题和答题记录自动更新。</p>
    </div>
    <div class="node-grid">
      ${nodes.map((node) => `
        <article class="knowledge-node ${node.level}">
          <span>${escapeHtml(node.status)}</span>
          <strong>${escapeHtml(node.name)}</strong>
          <p>${escapeHtml(node.reason)}</p>
        </article>
      `).join("")}
    </div>
  `;
}

function buildKnowledgeNodes() {
  const graphNodes = state.graph?.nodes || [];
  const questionNodes = state.questions.map((item) => item.skill);
  const weakSet = new Set(state.weakPoints);
  const correctSet = new Set(state.answers.filter((item) => item.correct).map((item) => item.skill));
  return unique([...graphNodes, ...questionNodes, ...state.weakPoints])
    .filter(Boolean)
    .slice(0, 12)
    .map((name) => {
      if (weakSet.has(name)) {
        return { name, status: "需巩固", level: "weak", reason: "诊断或练习中出现错误，后续优先抽题。" };
      }
      if (correctSet.has(name)) {
        return { name, status: "较稳定", level: "stable", reason: "已在题目中答对，可继续迁移应用。" };
      }
      return { name, status: "待确认", level: "pending", reason: "已进入个人知识图谱，等待诊断验证。" };
    });
}

function saveRecord(status) {
  if (!state.sessionId) return;
  const records = readRecords();
  const index = records.findIndex((item) => item.id === state.sessionId);
  const record = {
    id: state.sessionId,
    status,
    updatedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    profile: state.profile,
    weakPoints: [...state.weakPoints],
    answerCount: state.answers.length,
    correctCount: state.answers.filter((item) => item.correct).length,
    sourceTitle: state.source?.title || "",
  };
  if (index >= 0) records[index] = record;
  else records.unshift(record);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(0, 12)));
}

function renderRecentRecords() {
  const records = readRecords();
  if (!records.length || state.sessionId || !$("#indexResult")) return;
  $("#indexResult").innerHTML = `
    <div><span>最近记录</span><strong>${escapeHtml(records[0].profile?.subject || "未填写")}</strong></div>
    <div><span>进度</span><strong>${escapeHtml(records[0].status)}</strong></div>
    <div><span>更新时间</span><strong>${escapeHtml(records[0].updatedAt)}</strong></div>
  `;
}

function readRecords() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function sanitizeQuestions(questions) {
  const list = Array.isArray(questions) ? questions : [];
  const fallback = [
    {
      skill: "基础概念",
      question: "学习一个新主题时，最先应该确认什么？",
      answer: "哪些内容是前置基础",
      options: ["哪些内容是前置基础", "资料一共有几页", "哪个软件最流行", "封面是否好看"],
    },
    {
      skill: "题目分析",
      question: "看到题目不会下手时，通常先做哪一步？",
      answer: "找已知条件和目标之间的关系",
      options: ["找已知条件和目标之间的关系", "直接套最长公式", "先猜答案", "跳过所有基础"],
    },
    {
      skill: "复习策略",
      question: "为了减少学完就忘，路线里应该加入什么？",
      answer: "按错题和时间安排回顾",
      options: ["按错题和时间安排回顾", "只往后学新内容", "每天换一个主题", "只整理目录"],
    },
  ];

  const source = [];
  for (const item of (list.length ? list : fallback)) {
    if (!item?.question) continue;
    if (source.some((known) => normalizeText(known.question) === normalizeText(item.question))) continue;
    source.push(item);
  }
  while (source.length < 3) source.push(fallback[source.length % fallback.length]);

  return source.slice(0, 3).map((item, index) => {
    const options = Array.isArray(item.options) ? item.options.slice(0, 4) : [];
    while (options.length < 4) options.push(`选项 ${options.length + 1}`);
    const cleanedOptions = options.slice(0, 4).map((option) => String(option).trim());
    const answer = resolveAnswer(item.answer, cleanedOptions);
    return {
      skill: item.skill || `问题点 ${index + 1}`,
      question: item.question || fallback[index]?.question || "下面哪一项更合适？",
      answer,
      options: shuffle(cleanedOptions),
    };
  });
}

function loading(text) {
  return `<div class="loading"><i></i><span>${escapeHtml(text)}</span></div>`;
}

function updateBadge(data) {
  // Hidden from the learner-facing UI.
}

function shake(selector) {
  const el = $(selector);
  el.classList.add("shake");
  el.focus();
  setTimeout(() => el.classList.remove("shake"), 420);
}

async function requestJson(url, body) {
  const options = body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : {};
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function rememberQuestion(question) {
  const key = normalizeText(question);
  if (key) state.seenQuestions.add(key);
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[，。？！,.?!：“”"']/g, "")
    .replace(/^[A-Da-d][.、]/g, "")
    .toLowerCase();
}

function makeLocalVariantQuestion(question, attempt) {
  const skill = question?.skill || state.weakPoints.at(-1) || "当前薄弱点";
  const variants = [
    {
      skill,
      question: `换一种问法：关于「${skill}」，如果你要给别人讲清楚它，第一步最应该说明什么？`,
      answer: "它和前后知识点的关系",
      options: ["它和前后知识点的关系", "它的名字是否好记", "直接背答案", "跳过例题"],
    },
    {
      skill,
      question: `应用检查：遇到一道关于「${skill}」的题时，最稳妥的处理顺序是什么？`,
      answer: "先找条件和目标，再选择方法",
      options: ["先找条件和目标，再选择方法", "先看答案再反推", "直接猜一个选项", "只圈关键词"],
    },
  ];
  return variants[attempt % variants.length];
}

function resolveAnswer(answer, options) {
  const raw = String(answer || "").trim();
  if (options.includes(raw)) return raw;
  const letter = raw.match(/^[A-Da-d]/)?.[0]?.toUpperCase();
  if (letter) {
    const index = "ABCD".indexOf(letter);
    if (options[index]) return options[index];
    const prefixed = options.find((option) => option.trim().toUpperCase().startsWith(`${letter}.`) || option.trim().toUpperCase().startsWith(`${letter}、`));
    if (prefixed) return prefixed;
  }
  return options[0];
}

function shuffle(items) {
  return items
    .map((value) => ({ value, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map((item) => item.value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

init();
