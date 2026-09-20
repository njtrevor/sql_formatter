// SQL 格式化逻辑 —— 从 Python 版本移植而来, 供纯前端(浏览器)使用
// 对外只暴露一个函数: formatSql(sqlText, lowercaseIdentifiers) -> string

(function (global) {
  "use strict";

  // ============================================================
  // 0. 自定义 {} 条件块占位符处理
  // ============================================================
  const BRACE_BLOCK_RE = /\{[^{}]*\}/g;
  const BRACE_PLACEHOLDER_PREFIX = "__SQLFMT_BRACE_";

  function extractBraceBlocks(sqlText) {
    const mapping = {};
    let idx = 0;
    const newText = sqlText.replace(BRACE_BLOCK_RE, (m) => {
      const placeholder = `${BRACE_PLACEHOLDER_PREFIX}${idx}__`;
      mapping[placeholder] = m;
      idx += 1;
      return placeholder;
    });
    return [newText, mapping];
  }

  function restoreBraceBlocks(text, mapping) {
    for (const placeholder in mapping) {
      text = text.split(placeholder).join(mapping[placeholder]);
    }
    return text;
  }

  // ============================================================
  // 1. 词法分析(Tokenizer)
  // ============================================================
  const TOKEN_REGEX = new RegExp(
    [
      "(?<COMMENT>--[^\\n]*|/\\*[\\s\\S]*?\\*/)",
      "(?<STRING>'(?:[^']|'')*')",
      "(?<QIDENT>\"(?:[^\"]|\"\")*\"|`[^`]*`)",
      "(?<NUMBER>\\d+\\.\\d+|\\d+)",
      "(?<WORD>[A-Za-z_][A-Za-z0-9_$]*)",
      "(?<OP><>|<=|>=|!=|\\|\\||::|[=<>+\\-*/%])",
      "(?<PUNCT>[(){},.;])",
      "(?<WS>\\s+)",
    ].join("|"),
    "y"
  );

  function tokenize(sql) {
    const tokens = [];
    let pos = 0;
    const length = sql.length;
    TOKEN_REGEX.lastIndex = 0;
    while (pos < length) {
      TOKEN_REGEX.lastIndex = pos;
      const m = TOKEN_REGEX.exec(sql);
      if (!m || m.index !== pos) {
        tokens.push({ type: "PUNCT", text: sql[pos] });
        pos += 1;
        continue;
      }
      const groups = m.groups;
      let kind = null;
      for (const key in groups) {
        if (groups[key] !== undefined) {
          kind = key;
          break;
        }
      }
      const text = m[0];
      pos = TOKEN_REGEX.lastIndex;
      if (kind === "WS") continue;
      tokens.push({ type: kind, text: text });
    }
    return tokens;
  }

  // ============================================================
  // 2. 关键字大小写处理
  // ============================================================
  const KEYWORDS = new Set([
    "SELECT", "DISTINCT", "FROM", "WHERE", "AND", "OR", "NOT", "AS",
    "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "ON",
    "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "OFFSET",
    "UNION", "ALL", "WITH", "IN", "IS", "NULL", "LIKE", "BETWEEN",
    "EXISTS", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE",
    "CREATE", "TABLE", "VIEW", "ASC", "DESC", "TRUE", "FALSE",
    "CASE", "WHEN", "THEN", "ELSE", "END", "OVER", "PARTITION",
    "ROWS", "RANGE", "UNBOUNDED", "PRECEDING", "FOLLOWING",
    "CURRENT", "ROW", "CAST", "USING", "ANY", "SOME", "INTERVAL",
    "QUALIFY", "WINDOW", "FETCH", "FIRST", "NEXT", "ONLY", "ANTI"
  ]);

  const EXCLUDED_FUNCTIONS = new Set(["generate_hash64_key_column"]);

  function applyCasing(tokens, lowercaseIdentifiers) {
    for (const tok of tokens) {
      if (tok.type !== "WORD") continue;
      if (EXCLUDED_FUNCTIONS.has(tok.text.toLowerCase())) continue;
      if (tok.text.startsWith(BRACE_PLACEHOLDER_PREFIX)) continue;
      if (KEYWORDS.has(tok.text.toUpperCase())) {
        tok.text = tok.text.toUpperCase();
      } else if (lowercaseIdentifiers) {
        tok.text = tok.text.toLowerCase();
      }
    }
  }

  // ============================================================
  // 3. 通用辅助函数
  // ============================================================
  function findMatchingParen(tokens, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === "PUNCT" && t.text === "(") depth += 1;
      else if (t.type === "PUNCT" && t.text === ")") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return tokens.length - 1;
  }

  function findCaseEnd(tokens, startIdx) {
    let depth = 0;
    for (let i = startIdx; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === "WORD" && t.text === "CASE") depth += 1;
      else if (t.type === "WORD" && t.text === "END") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return tokens.length - 1;
  }

  function splitTopLevelCommas(tokens) {
    let depth = 0;
    const segments = [];
    let cur = [];
    for (const t of tokens) {
      if (t.type === "PUNCT" && t.text === "(") {
        depth += 1;
        cur.push(t);
      } else if (t.type === "PUNCT" && t.text === ")") {
        depth -= 1;
        cur.push(t);
      } else if (t.type === "PUNCT" && t.text === "," && depth === 0) {
        segments.push(cur);
        cur = [];
      } else {
        cur.push(t);
      }
    }
    segments.push(cur);
    return segments.filter((s) => s.length > 0);
  }

  function splitAndOr(tokens) {
    let depth = 0;
    const segments = [];
    let cur = [];
    let conj = null;
    for (const t of tokens) {
      if (t.type === "PUNCT" && t.text === "(") depth += 1;
      else if (t.type === "PUNCT" && t.text === ")") depth -= 1;
      if (depth === 0 && t.type === "WORD" && (t.text === "AND" || t.text === "OR")) {
        segments.push([conj, cur]);
        cur = [];
        conj = t.text;
      } else {
        cur.push(t);
      }
    }
    segments.push([conj, cur]);
    return segments.filter((s) => s[1].length > 0);
  }

  function findTopLevelKeyword(tokens, keyword) {
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === "PUNCT" && t.text === "(") depth += 1;
      else if (t.type === "PUNCT" && t.text === ")") depth -= 1;
      else if (depth === 0 && t.type === "WORD" && t.text === keyword) return i;
    }
    return null;
  }

  // ============================================================
  // 4. 单行渲染
  // ============================================================
  const NO_SPACE_BEFORE = new Set([",", ")", ".", ";"]);
  const NO_SPACE_AFTER = new Set(["(", "."]);
  const NO_SPACE_BEFORE_PAREN_PREV = new Set([
    "IN", "AND", "OR", "NOT", "EXISTS", "BETWEEN", "VALUES",
  ]);

  function renderInline(tokens) {
    const out = [];
    let prev = null;
    for (const t of tokens) {
      const text = t.text;
      let needSpace = true;
      if (prev === null) {
        needSpace = false;
      } else if (t.type === "PUNCT" && NO_SPACE_BEFORE.has(text)) {
        needSpace = false;
      } else if (prev.type === "PUNCT" && NO_SPACE_AFTER.has(prev.text)) {
        needSpace = false;
      } else if (t.type === "PUNCT" && text === "(") {
        if (
          (prev.type === "WORD" || prev.type === "QIDENT") &&
          !NO_SPACE_BEFORE_PAREN_PREV.has(prev.text.toUpperCase())
        ) {
          needSpace = false;
        }
      } else if (t.type === "OP" && text === "::") {
        needSpace = false;
      } else if (prev.type === "OP" && prev.text === "::") {
        needSpace = false;
      }
      if (needSpace) out.push(" ");
      out.push(text);
      prev = t;
    }
    return out.join("");
  }

  // ============================================================
  // 5. CASE / 函数调用(含 DECODE) 专用多行渲染
  // ============================================================
  const LINE_LIMIT = 140;

  function renderCase(tokens, col) {
    let depth = 0;
    const segments = [];
    let cur = [];
    let mode = null;
    const inner = tokens.slice(1, tokens.length - 1);
    for (const t of inner) {
      if (t.type === "PUNCT" && t.text === "(") depth += 1;
      else if (t.type === "PUNCT" && t.text === ")") depth -= 1;
      if (depth === 0 && t.type === "WORD" && ["WHEN", "THEN", "ELSE"].includes(t.text)) {
        if (cur.length) segments.push([mode, cur]);
        cur = [];
        mode = t.text;
      } else {
        cur.push(t);
      }
    }
    if (cur.length) segments.push([mode, cur]);

    const ind = " ".repeat(col + 4);
    const lines = ["CASE"];
    let i = 0;
    while (i < segments.length) {
      const [kw, toks] = segments[i];
      if (kw === "WHEN") {
        const whenStr = renderInline(toks);
        let thenStr = "";
        let thenToks = [];
        if (i + 1 < segments.length && segments[i + 1][0] === "THEN") {
          thenToks = segments[i + 1][1];
          thenStr = renderInline(thenToks);
          i += 1;
        }
        const fullLine = `${ind}WHEN ${whenStr} THEN ${thenStr}`;
        if (fullLine.length <= LINE_LIMIT && !hasLineComment(toks) && !hasLineComment(thenToks)) {
          lines.push(fullLine);
        } else {
          const condSegments = splitAndOr(toks);
          lines.push(...renderWithPrefix(`${ind}WHEN `, condSegments[0][1]));
          const condInd = ind + "    ";
          for (let k = 1; k < condSegments.length; k++) {
            const [conj, ctoks] = condSegments[k];
            lines.push(...renderWithPrefix(`${condInd}${conj} `, ctoks));
          }
          lines.push(...renderWithPrefix(`${condInd}THEN `, thenToks));
        }
      } else if (kw === "ELSE") {
        const elseLine = `${ind}ELSE ${renderInline(toks)}`;
        if (elseLine.length <= LINE_LIMIT && !hasLineComment(toks)) {
          lines.push(elseLine);
        } else {
          lines.push(...renderWithPrefix(`${ind}ELSE `, toks));
        }
      }
      i += 1;
    }
    lines.push(" ".repeat(col) + "END");
    return lines;
  }

  function renderDecode(tokens, col) {
    const name = tokens[0].text;
    const closeIdx = findMatchingParen(tokens, 1);
    const inner = tokens.slice(2, closeIdx);
    const args = splitTopLevelCommas(inner);

    const ind = " ".repeat(col + 4);
    const lines = [name + "("];

    const arg0 = args.length ? args[0] : [];
    const arg0Rendered = renderExpr(arg0, col + 4);
    if (Array.isArray(arg0Rendered)) {
      lines.push(ind + arg0Rendered[0]);
      lines.push(...arg0Rendered.slice(1));
    } else {
      lines.push(ind + arg0Rendered);
    }

    const restArgs = args.slice(1);
    if (restArgs.length) {
      const remainingInline = restArgs.map((a) => renderInline(a)).join(", ");
      const candidateLast = lines[lines.length - 1] + ", " + remainingInline + ")";
      if (candidateLast.length <= LINE_LIMIT) {
        lines[lines.length - 1] = candidateLast;
        return lines;
      }
      let i = 0;
      while (i < restArgs.length) {
        if (i + 1 < restArgs.length) {
          lines.push(
            ind + ", " + renderInline(restArgs[i]) + ", " + renderInline(restArgs[i + 1])
          );
          i += 2;
        } else {
          lines.push(ind + ", " + renderInline(restArgs[i]));
          i += 1;
        }
      }
      lines.push(" ".repeat(col) + ")");
    } else {
      lines.push(" ".repeat(col) + ")");
    }
    return lines;
  }

  function renderGenericCall(tokens, col) {
    const name = tokens[0].text;
    const closeIdx = findMatchingParen(tokens, 1);
    const inner = tokens.slice(2, closeIdx);
    const args = splitTopLevelCommas(inner);

    const ind = " ".repeat(col + 4);
    const closeInd = " ".repeat(col);
    const lines = [name + "("];

    if (args.length === 1 && args[0].length && args[0][0].type === "WORD" && args[0][0].text === "CASE") {
      const rendered = renderExpr(args[0], col + 4);
      if (Array.isArray(rendered)) {
        lines.push(ind + rendered[0]);
        lines.push(...rendered.slice(1));
      } else {
        lines.push(ind + rendered);
      }
      lines.push(closeInd + ")");
      return lines;
    }

    for (let idx = 0; idx < args.length; idx++) {
      const a = args[idx];
      const rendered = renderExpr(a, col + 4);
      const prefix = idx === 0 ? ind : ind + ", ";
      if (Array.isArray(rendered)) {
        lines.push(prefix + rendered[0]);
        lines.push(...rendered.slice(1));
      } else {
        lines.push(prefix + rendered);
      }
    }
    lines.push(closeInd + ")");
    return lines;
  }

  function commentIndent(chunk, indent) {
    if (chunk.length && chunk[0].text.startsWith("/*")) return "";
    return indent;
  }

  function attachTrailing(lines, trailing, col) {
    if (!trailing || !trailing.length) return lines;
    const indent = " ".repeat(col);
    for (const [isComment, chunk] of splitOutLineComments(trailing)) {
      if (isComment) {
        lines.push(commentIndent(chunk, indent) + renderInline(chunk));
      } else {
        lines[lines.length - 1] += " " + renderInline(chunk);
      }
    }
    return lines;
  }

  // ---- 窗口函数 OVER(...) 专用渲染 --------------------------------------
  const WINDOW_CLAUSE_KEYWORDS = [
    [["PARTITION", "BY"], "PARTITION BY"],
    [["ORDER", "BY"], "ORDER BY"],
    [["ROWS"], "ROWS"],
    [["RANGE"], "RANGE"],
  ];

  function splitWindowClause(tokens) {
    let depth = 0;
    const segments = [];
    let curLabel = null;
    let curKw = null;
    let curTokens = [];
    let i = 0;
    const n = tokens.length;
    while (i < n) {
      const t = tokens[i];
      if (t.type === "PUNCT" && t.text === "(") depth += 1;
      else if (t.type === "PUNCT" && t.text === ")") depth -= 1;
      let matched = null;
      if (depth === 0) {
        for (const [words, label] of WINDOW_CLAUSE_KEYWORDS) {
          const m = words.length;
          if (
            i + m <= n &&
            words.every((w, k) => tokens[i + k].type === "WORD" && tokens[i + k].text === w)
          ) {
            matched = [words.join(" "), label, m];
            break;
          }
        }
      }
      if (matched) {
        const [kwText, label, consumed] = matched;
        if (curLabel !== null || curTokens.length) segments.push([curLabel, curKw, curTokens]);
        curLabel = label;
        curKw = kwText;
        curTokens = [];
        i += consumed;
        continue;
      }
      curTokens.push(t);
      i += 1;
    }
    if (curLabel !== null || curTokens.length) segments.push([curLabel, curKw, curTokens]);
    return segments;
  }

  function renderWindowSpec(innerTokens, baseCol) {
    const segments = splitWindowClause(innerTokens);
    const ind = " ".repeat(baseCol + 4);
    const closeInd = " ".repeat(baseCol);
    const lines = ["OVER ("];
    for (const [label, kwText, content] of segments) {
      if (!content.length) continue;
      if (label === "PARTITION BY" || label === "ORDER BY") {
        const items = splitTopLevelCommas(content);
        const renderedItems = items.map((it) => renderExpr(it, ind.length + kwText.length + 1));
        const allInline = renderedItems.every((r) => typeof r === "string") && !hasLineComment(content);
        const header = ind + kwText + " ";
        if (allInline && (header.length + renderedItems.join(", ").length) <= LINE_LIMIT) {
          lines.push(header + renderedItems.join(", "));
        } else {
          lines.push(ind + kwText);
          const itemInd = ind + "    ";
          for (let idx = 0; idx < items.length; idx++) {
            const prefix = idx === 0 ? itemInd : itemInd + ", ";
            lines.push(...renderWithPrefix(prefix, items[idx]));
          }
        }
      } else {
        lines.push(ind + kwText + " " + renderInline(content));
      }
    }
    lines.push(closeInd + ")");
    return lines;
  }

  function splitBinaryOps(tokens, ops) {
    ops = ops || ["+", "-", "||"];
    let depth = 0;
    const segments = [];
    let cur = [];
    let op = null;
    for (const t of tokens) {
      if (t.type === "PUNCT" && t.text === "(") depth += 1;
      else if (t.type === "PUNCT" && t.text === ")") depth -= 1;
      if (depth === 0 && t.type === "OP" && ops.includes(t.text) && cur.length) {
        segments.push([op, cur]);
        cur = [];
        op = t.text;
      } else {
        cur.push(t);
      }
    }
    segments.push([op, cur]);
    return segments;
  }

  function renderExpr(tokens, col) {
    if (!tokens.length) return "";

    // 1) 被括号包住的表达式
    if (tokens[0].type === "PUNCT" && tokens[0].text === "(") {
      const close0 = findMatchingParen(tokens, 0);
      const inner = tokens.slice(1, close0);
      if (
        inner.length &&
        inner[0].type === "WORD" &&
        inner[0].text === "CASE" &&
        findCaseEnd(inner, 0) === inner.length - 1
      ) {
        const trailing = tokens.slice(close0 + 1);
        const inlineFull = renderInline(tokens.slice(0, close0 + 1));
        const fullStr = inlineFull + (trailing.length ? " " + renderInline(trailing) : "");
        if (col + fullStr.length <= LINE_LIMIT && !hasLineComment(trailing)) {
          return fullStr;
        }
        const caseLines = renderCase(inner, col);
        const lines = caseLines.slice();
        lines[0] = "(" + lines[0];
        lines[lines.length - 1] = lines[lines.length - 1] + ")";
        attachTrailing(lines, trailing, col);
        return lines;
      }

      // 1b) 括号包住的普通条件表达式(不是 CASE)
      const trailing = tokens.slice(close0 + 1);
      const inlineFull = renderInline(tokens.slice(0, close0 + 1));
      const fullStr = inlineFull + (trailing.length ? " " + renderInline(trailing) : "");
      if (col + fullStr.length <= LINE_LIMIT && !hasLineComment(trailing)) {
        return fullStr;
      }
      const condSegments = splitAndOr(inner);
      let lines;
      if (condSegments.length > 1) {
        const firstRendered = renderExpr(condSegments[0][1], col + 1);
        if (typeof firstRendered === "string") {
          lines = ["(" + firstRendered];
        } else {
          lines = ["(" + firstRendered[0]];
          lines.push(...firstRendered.slice(1));
        }
        const condInd = " ".repeat(col + 4);
        for (let k = 1; k < condSegments.length; k++) {
          const [conj, ctoks] = condSegments[k];
          lines.push(...renderWithPrefix(`${condInd}${conj} `, ctoks));
        }
        lines[lines.length - 1] = lines[lines.length - 1] + ")";
      } else {
        lines = [inlineFull];
      }
      attachTrailing(lines, trailing, col);
      return lines;
    }

    // 1c) 一元前缀(负号/NOT)
    if (
      (tokens[0].type === "OP" && (tokens[0].text === "-" || tokens[0].text === "+")) ||
      (tokens[0].type === "WORD" && tokens[0].text === "NOT")
    ) {
      const prefixText = tokens[0].text;
      const restResult = renderExpr(tokens.slice(1), col + prefixText.length + 1);
      if (typeof restResult === "string") {
        return prefixText + " " + restResult;
      }
      const lines = restResult.slice();
      lines[0] = prefixText + " " + lines[0];
      return lines;
    }

    // 1d) 顶层由 +/-/|| 连接的复合表达式
    const opSegments = splitBinaryOps(tokens);
    if (opSegments.length > 1) {
      const inlineFull = renderInline(tokens);
      if (col + inlineFull.length <= LINE_LIMIT && !hasLineComment(tokens)) {
        return inlineFull;
      }
      const [, firstToks] = opSegments[0];
      const firstRendered = renderExpr(firstToks, col);
      let lines;
      if (typeof firstRendered === "string") {
        lines = [firstRendered];
      } else {
        lines = [firstRendered[0]];
        lines.push(...firstRendered.slice(1));
      }
      const contPrefix = " ".repeat(col);
      for (let k = 1; k < opSegments.length; k++) {
        const [op, toks] = opSegments[k];
        lines.push(...renderWithPrefix(`${contPrefix}${op} `, toks));
      }
      return lines;
    }

    // 2) 完整的 CASE ... END
    if (tokens[0].type === "WORD" && tokens[0].text === "CASE") {
      const endIdx = findCaseEnd(tokens, 0);
      const lines = renderCase(tokens.slice(0, endIdx + 1), col);
      const trailing = tokens.slice(endIdx + 1);
      attachTrailing(lines, trailing, col);
      return lines;
    }

    // 3) 任意函数调用
    if (tokens[0].type === "WORD" && tokens.length > 1 && tokens[1].type === "PUNCT" && tokens[1].text === "(") {
      const closeIdx = findMatchingParen(tokens, 1);
      const rest = tokens.slice(closeIdx + 1);

      // 3a) 窗口函数
      if (
        rest.length &&
        rest[0].type === "WORD" &&
        rest[0].text === "OVER" &&
        rest.length > 1 &&
        rest[1].type === "PUNCT" &&
        rest[1].text === "("
      ) {
        const overClose = findMatchingParen(rest, 1);
        const overInner = rest.slice(2, overClose);
        const afterOver = rest.slice(overClose + 1);
        const head = renderInline(tokens.slice(0, closeIdx + 1));
        let fullStr = head + " " + renderInline(rest.slice(0, overClose + 1));
        if (afterOver.length) fullStr = fullStr + " " + renderInline(afterOver);
        if (col + fullStr.length <= LINE_LIMIT && !hasLineComment(afterOver)) {
          return fullStr;
        }
        const windowLines = renderWindowSpec(overInner, col);
        const lines = [head + " " + windowLines[0]];
        lines.push(...windowLines.slice(1));
        attachTrailing(lines, afterOver, col);
        return lines;
      }

      const inlineFull = renderInline(tokens.slice(0, closeIdx + 1));
      const trailing = rest;
      const fullStr = inlineFull + (trailing.length ? " " + renderInline(trailing) : "");
      if (col + fullStr.length <= LINE_LIMIT && !hasLineComment(trailing)) {
        return fullStr;
      }
      const nameLower = tokens[0].text.toLowerCase();
      let lines;
      if (nameLower === "decode") {
        lines = renderDecode(tokens.slice(0, closeIdx + 1), col);
      } else {
        lines = renderGenericCall(tokens.slice(0, closeIdx + 1), col);
      }
      attachTrailing(lines, trailing, col);
      return lines;
    }

    // 4) 其他普通表达式
    return renderInline(tokens);
  }

  function hasLineComment(tokens) {
    return tokens.some((t) => t.type === "COMMENT");
  }

  function splitOutLineComments(tokens) {
    const result = [];
    let cur = [];
    for (const t of tokens) {
      if (t.type === "COMMENT") {
        if (cur.length) {
          result.push([false, cur]);
          cur = [];
        }
        result.push([true, [t]]);
      } else {
        cur.push(t);
      }
    }
    if (cur.length) result.push([false, cur]);
    return result;
  }

  function renderWithPrefix(prefix, tokens) {
    const plainIndent = " ".repeat(prefix.length);
    const chunks = splitOutLineComments(tokens);
    const lines = [];
    let codeStarted = false;
    for (const [isComment, chunk] of chunks) {
      if (isComment) {
        lines.push(commentIndent(chunk, plainIndent) + renderInline(chunk));
        continue;
      }
      const curPrefix = codeStarted ? plainIndent : prefix;
      const col = curPrefix.length;
      const rendered = renderExpr(chunk, col);
      if (typeof rendered === "string") {
        lines.push(curPrefix + rendered);
      } else {
        lines.push(curPrefix + rendered[0]);
        lines.push(...rendered.slice(1));
      }
      codeStarted = true;
    }
    if (!lines.length) {
      lines.push(prefix.replace(/\s+$/, ""));
    }
    return lines;
  }

  // ============================================================
  // 6. 各个 SQL 子句的格式化
  // ============================================================
  function formatSelect(tokens, baseIndent) {
    baseIndent = baseIndent || 0;
    const base = " ".repeat(baseIndent);
    let selectKw = "SELECT";
    if (tokens.length && tokens[0].type === "WORD" && (tokens[0].text === "DISTINCT" || tokens[0].text === "ALL")) {
      selectKw = `SELECT ${tokens[0].text}`;
      tokens = tokens.slice(1);
    }

    const fields = splitTopLevelCommas(tokens);
    const anyComment = fields.some((f) => hasLineComment(f));
    const inlineCandidates = fields.map((f) => renderExpr(f, baseIndent + 4));
    const allInline = !anyComment && inlineCandidates.every((r) => typeof r === "string");
    const merged = allInline ? base + "    " + inlineCandidates.join(", ") : "";

    const lines = [base + selectKw];
    if (allInline && merged.length <= LINE_LIMIT) {
      lines.push(merged);
      return lines;
    }

    for (let idx = 0; idx < fields.length; idx++) {
      const prefix = idx === 0 ? base + "    " : base + "    , ";
      lines.push(...renderWithPrefix(prefix, fields[idx]));
    }
    return lines;
  }

  function formatGroupOrOrderBy(kwText, tokens, baseIndent) {
    baseIndent = baseIndent || 0;
    const base = " ".repeat(baseIndent);
    const items = splitTopLevelCommas(tokens);
    const anyComment = items.some((it) => hasLineComment(it));
    const rendered = items.map((it) => renderInline(it));
    const joined = rendered.join(", ");
    if (!anyComment && baseIndent + kwText.length + 1 + joined.length <= LINE_LIMIT) {
      return [`${base}${kwText} ${joined}`];
    }
    const lines = [base + kwText];
    for (let idx = 0; idx < items.length; idx++) {
      const prefix = idx === 0 ? base + "    " : base + "    , ";
      lines.push(...renderWithPrefix(prefix, items[idx]));
    }
    return lines;
  }

  function formatWhereLike(kwText, tokens, baseIndent) {
    baseIndent = baseIndent || 0;
    const base = " ".repeat(baseIndent);
    const segments = splitAndOr(tokens);
    const lines = renderWithPrefix(`${base}${kwText} `, segments[0][1]);
    for (let k = 1; k < segments.length; k++) {
      const [conj, toks] = segments[k];
      lines.push(...renderWithPrefix(`${base}    ${conj} `, toks));
    }
    return lines;
  }

  function formatTableRef(kwText, tokens, baseIndent) {
    baseIndent = baseIndent || 0;
    const base = " ".repeat(baseIndent);
    if (tokens.length && tokens[0].type === "PUNCT" && tokens[0].text === "(") {
      const close0 = findMatchingParen(tokens, 0);
      const inner = tokens.slice(1, close0);
      const trailing = tokens.slice(close0 + 1);
      if (inner.length && inner[0].type === "WORD" && (inner[0].text === "SELECT" || inner[0].text === "WITH")) {
        const lines = [`${base}${kwText} (`];
        lines.push(...formatStatement(inner, baseIndent + 4));
        let closing = base + ")";
        if (trailing.length) closing += " " + renderInline(trailing);
        lines.push(closing);
        return lines;
      }
    }
    return [`${base}${kwText} ` + renderInline(tokens)];
  }

  function formatWith(tokens, baseIndent) {
    baseIndent = baseIndent || 0;
    const base = " ".repeat(baseIndent);
    const ctes = splitTopLevelCommas(tokens);
    const lines = [base + "WITH"];
    for (let idx = 0; idx < ctes.length; idx++) {
      const cte = ctes[idx];
      const prefix = idx === 0 ? base + "    " : base + "    , ";
      let openIdx = null;
      for (let i = 0; i < cte.length; i++) {
        if (cte[i].type === "PUNCT" && cte[i].text === "(") {
          openIdx = i;
          break;
        }
      }
      if (openIdx === null) {
        lines.push(...renderWithPrefix(prefix, cte));
        continue;
      }
      const namePart = cte.slice(0, openIdx);
      const closeIdx = findMatchingParen(cte, openIdx);
      const inner = cte.slice(openIdx + 1, closeIdx);
      const trailing = cte.slice(closeIdx + 1);
      const header = renderInline(namePart);
      lines.push(`${prefix}${header} (`);
      lines.push(...formatStatement(inner, baseIndent + 8));
      let closing = base + "    )";
      if (trailing.length) closing += " " + renderInline(trailing);
      lines.push(closing);
    }
    return lines;
  }

  function formatJoin(kwText, tokens, baseIndent) {
    baseIndent = baseIndent || 0;
    const base = " ".repeat(baseIndent);
    const onIdx = findTopLevelKeyword(tokens, "ON");
    const tablePart = onIdx === null ? tokens : tokens.slice(0, onIdx);
    const onPart = onIdx === null ? null : tokens.slice(onIdx + 1);

    const lines = formatTableRef(kwText, tablePart, baseIndent);

    if (onPart) {
      const segments = splitAndOr(onPart);
      lines.push(...renderWithPrefix(`${base}    ON `, segments[0][1]));
      for (let k = 1; k < segments.length; k++) {
        const [conj, toks] = segments[k];
        lines.push(...renderWithPrefix(`${base}    ${conj} `, toks));
      }
    }
    return lines;
  }

  // ============================================================
  // 7. 顶层子句拆分
  // ============================================================
  const CLAUSE_KEYWORDS = [
    [["SELECT"], "SELECT"],
    [["FROM"], "FROM"],
    [["LEFT", "OUTER", "JOIN"], "JOIN"],
    [["LEFT", "ANIT", "JOIN"], "JOIN"],
    [["ANTI", "JOIN"], "JOIN"],
    [["RIGHT", "OUTER", "JOIN"], "JOIN"],
    [["FULL", "OUTER", "JOIN"], "JOIN"],
    [["LEFT", "JOIN"], "JOIN"],
    [["RIGHT", "JOIN"], "JOIN"],
    [["FULL", "JOIN"], "JOIN"],
    [["INNER", "JOIN"], "JOIN"],
    [["CROSS", "JOIN"], "JOIN"],
    [["JOIN"], "JOIN"],
    [["WHERE"], "WHERE"],
    [["GROUP", "BY"], "GROUP BY"],
    [["ORDER", "BY"], "ORDER BY"],
    [["HAVING"], "HAVING"],
    [["LIMIT"], "LIMIT"],
    [["OFFSET"], "OFFSET"],
    [["UNION", "ALL"], "UNION ALL"],
    [["UNION"], "UNION"],
    [["WITH"], "WITH"],
  ];

  function matchClause(tokens, i) {
    for (const [words, label] of CLAUSE_KEYWORDS) {
      const n = words.length;
      if (i + n > tokens.length) continue;
      let ok = true;
      for (let k = 0; k < n; k++) {
        const t = tokens[i + k];
        if (t.type !== "WORD" || t.text !== words[k]) {
          ok = false;
          break;
        }
      }
      if (ok) return [words.join(" "), label, n];
    }
    return null;
  }

  function splitStatementIntoClauses(tokens) {
    let depth = 0;
    const segments = [];
    let curLabel = null;
    let curKw = null;
    let curTokens = [];
    let i = 0;
    const n = tokens.length;
    while (i < n) {
      const t = tokens[i];
      if (t.type === "PUNCT" && t.text === "(") depth += 1;
      else if (t.type === "PUNCT" && t.text === ")") depth -= 1;

      let matched = null;
      if (depth === 0) matched = matchClause(tokens, i);

      if (matched) {
        const [kwText, label, consumed] = matched;
        if (curLabel !== null || curTokens.length) segments.push([curLabel, curKw, curTokens]);
        curLabel = label;
        curKw = kwText;
        curTokens = [];
        i += consumed;
        continue;
      }
      curTokens.push(t);
      i += 1;
    }
    if (curLabel !== null || curTokens.length) segments.push([curLabel, curKw, curTokens]);
    return segments;
  }

  function formatStatement(tokens, baseIndent) {
    baseIndent = baseIndent || 0;
    const base = " ".repeat(baseIndent);
    const segments = splitStatementIntoClauses(tokens);
    const lines = [];
    for (const [label, kwText, content] of segments) {
      if (label === null) {
        const text = renderInline(content);
        if (text.trim()) lines.push(base + text);
        continue;
      }
      if (!content.length && label !== "FROM") {
        lines.push(base + kwText);
        continue;
      }
      if (label === "SELECT") {
        lines.push(...formatSelect(content, baseIndent));
      } else if (label === "FROM") {
        lines.push(...formatTableRef("FROM", content, baseIndent));
      } else if (label === "JOIN") {
        lines.push(...formatJoin(kwText, content, baseIndent));
      } else if (label === "WHERE" || label === "HAVING") {
        lines.push(...formatWhereLike(kwText, content, baseIndent));
      } else if (label === "GROUP BY" || label === "ORDER BY") {
        lines.push(...formatGroupOrOrderBy(kwText, content, baseIndent));
      } else if (label === "WITH") {
        lines.push(...formatWith(content, baseIndent));
      } else {
        lines.push(`${base}${kwText} ` + renderInline(content));
      }
    }
    return lines;
  }

  // ============================================================
  // 8. 自定义 {} 条件块换行处理 / 空行删除
  // ============================================================
  const PLACEHOLDER_RE = new RegExp(
    BRACE_PLACEHOLDER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\d+__"
  );

  function fixBraceBlocks(lines) {
    const result = [];
    for (const line of lines) {
      const m = PLACEHOLDER_RE.exec(line);
      if (!m) {
        result.push(line);
        continue;
      }
      if (line.trim() === m[0]) {
        result.push(line);
        continue;
      }
      const indentMatch = /^(\s*)/.exec(line);
      const indent = indentMatch[1];
      const before = line.slice(0, m.index).replace(/\s+$/, "");
      const braceText = m[0];
      const after = line.slice(m.index + m[0].length).trim();
      const newIndent = indent + "    ";
      if (before.trim()) result.push(before);
      let braceLine = newIndent + braceText;
      if (after) {
        const sep = after === ";" || after === "," ? "" : " ";
        braceLine += sep + after;
      }
      result.push(braceLine);
    }
    return result;
  }

  function removeBlankLines(lines) {
    return lines.filter((line) => line.trim() !== "");
  }

  // ============================================================
  // 9. 顶层入口
  // ============================================================
  function splitTopLevelStatements(tokens) {
    let depth = 0;
    const statements = [];
    let cur = [];
    for (const t of tokens) {
      if (t.type === "PUNCT" && t.text === "(") depth += 1;
      else if (t.type === "PUNCT" && t.text === ")") depth -= 1;
      if (depth === 0 && t.type === "PUNCT" && t.text === ";") {
        statements.push(cur);
        cur = [];
      } else {
        cur.push(t);
      }
    }
    if (cur.length) statements.push(cur);
    return statements;
  }

  function formatSql(sqlText, lowercaseIdentifiers) {
    lowercaseIdentifiers = !!lowercaseIdentifiers;
    let [text, braceMapping] = extractBraceBlocks(sqlText);
    const tokens = tokenize(text);
    applyCasing(tokens, lowercaseIdentifiers);
    const statements = splitTopLevelStatements(tokens);

    const renderedStatements = [];
    for (const stmtTokens of statements) {
      if (!stmtTokens.some((t) => t.type !== "COMMENT")) {
        if (stmtTokens.length) {
          renderedStatements.push([renderInline(stmtTokens)]);
        }
        continue;
      }
      renderedStatements.push(formatStatement(stmtTokens));
    }

    let outLines = [];
    for (const lines of renderedStatements) {
      if (!lines.length) continue;
      const copy = lines.slice();
      copy[copy.length - 1] = copy[copy.length - 1] + ";";
      outLines.push(...copy);
    }

    outLines = fixBraceBlocks(outLines);
    outLines = removeBlankLines(outLines);
    outLines = outLines.map((line) => line.replace(/\t/g, "    "));

    let result = outLines.join("\n") + "\n";
    result = restoreBraceBlocks(result, braceMapping);
    return result;
  }

  global.SqlFormatter = { formatSql: formatSql };
})(typeof window !== "undefined" ? window : globalThis);
