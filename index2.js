const { connect } = require("puppeteer-real-browser");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

// ------------------- CONFIG -------------------
const repoFolder = "D:\\Dev\\AutoSPOJ";
const jsonPath = path.join(repoFolder, "Data.json");

// ---- Semester mode ----
const SEMESTER_START_ISO = "2026-01-01T00:00:00+07:00";
const SEMESTER_END_ISO = "2026-04-05T23:59:59+07:00";

// If semester ended, do nothing unless FORCE_SCRAPE=true
const FORCE_SCRAPE = false;

// Delay range for ALL navigation/pagination (reduced from 1000-3000)
const MIN_DELAY_MS = 1100;
const MAX_DELAY_MS = 2000;

// Retry only the failed step
const MAX_STEP_RETRIES = 3;

// ------------------- UTILS -------------------
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const politeDelay = async () => sleep(randInt(MIN_DELAY_MS, MAX_DELAY_MS));

function loadJson(p) {
    if (!fs.existsSync(p)) throw new Error(`Data.json not found at: ${p}`);
    const txt = fs.readFileSync(p, "utf-8");
    if (!txt.trim()) throw new Error(`Data.json is empty: ${p}`);
    return JSON.parse(txt);
}

function saveJson(p, obj) {
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf-8");
}

function getCsharpFormattedDate(now) {
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, "0");
    const day = now.getDate().toString().padStart(2, "0");
    const hours = now.getHours().toString().padStart(2, "0");
    const minutes = now.getMinutes().toString().padStart(2, "0");
    const seconds = now.getSeconds().toString().padStart(2, "0");
    const ms = now.getMilliseconds().toString().padStart(3, "0");
    const ticks = ms + "0000";
    const offsetMinutes = now.getTimezoneOffset();
    const offsetHours = Math.abs(Math.floor(offsetMinutes / 60));
    const offsetMins = Math.abs(offsetMinutes % 60);
    const sign = offsetMinutes > 0 ? "-" : "+";
    const offsetString = `${sign}${offsetHours.toString().padStart(2, "0")}:${offsetMins
        .toString()
        .padStart(2, "0")}`;
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ticks}${offsetString}`;
}

function parseSpojDateToIso(dateText) {
    // SPOJ local time = Warsaw timezone (CET/CEST): UTC+1 in winter, UTC+2 in summer.
    const s = (dateText || "").trim();
    if (!s) return null;

    // If it already includes timezone info (Z or ±hh:mm), let Date parse it directly.
    if (/[zZ]|[+\-]\d{2}:\d{2}$/.test(s)) {
        const d = new Date(s);
        return isNaN(d.getTime()) ? null : d.toISOString();
    }

    // Accept both "YYYY-MM-DD HH:mm:ss" and "YYYY-MM-DDTHH:mm:ss"
    const m = s.match(
        /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/
    );
    if (!m) return null;

    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    const second = Number(m[6] ?? "0");

    const tz = "Europe/Warsaw";

    function tzOffsetMinutes(timeZone, utcDate) {
        const dtf = new Intl.DateTimeFormat("en-US", {
            timeZone,
            hour12: false,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });

        const parts = dtf.formatToParts(utcDate);
        const get = (type) => parts.find((p) => p.type === type)?.value;

        const y = Number(get("year"));
        const mo = Number(get("month"));
        const d = Number(get("day"));
        const h = Number(get("hour"));
        const mi = Number(get("minute"));
        const se = Number(get("second"));

        const asIfUtc = Date.UTC(y, mo - 1, d, h, mi, se);
        return (asIfUtc - utcDate.getTime()) / 60000;
    }

    const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
    let offset = tzOffsetMinutes(tz, new Date(utcGuess));
    let utc = utcGuess - offset * 60000;

    // One more iteration helps around DST boundaries
    offset = tzOffsetMinutes(tz, new Date(utc));
    utc = utcGuess - offset * 60000;

    const d = new Date(utc);
    return isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeLanguage(langText) {
    const s = (langText || "").trim().toLowerCase();
    if (!s) return "";
    if (s.includes("java")) return "Java";
    if (s.includes("c#") || s.includes("csharp")) return "C#";
    if (s.includes("js") || s.includes("javascript")) return "JS2";
    if (s.includes("python")) return "Python";
    if (s.includes("c++")) return "C++";
    if (s === "c") return "C";
    return (langText || "").trim();
}

function parseResultToScore(resultText) {
    const s = (resultText || "").trim();
    const num = Number(s);
    if (!Number.isNaN(num)) return num;
    return 0;
}

async function withRetry(stepName, fn, retries = MAX_STEP_RETRIES) {
    let lastErr = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            console.warn(`[Retry] ${stepName} failed (${attempt}/${retries}): ${err?.message || err}`);
            await politeDelay();
            // Exponential backoff: 1s, 2s, 4s
            // await sleep(1000 * Math.pow(2, attempt - 1));
        }
    }
    throw new Error(`[Fail] ${stepName} failed after ${retries} retries: ${lastErr?.message || lastErr}`);
}

async function safeGoto(page, url, selector = "table.problems") {
    await withRetry(`goto ${url}`, async () => {
        // await page.goto(url, { waitUntil: "networkidle2" });
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        // Wait for the table or a "no results" indicator, whichever comes first
        await page.waitForSelector(selector, { timeout: 10000 }).catch(() => { });
    });
    await politeDelay();
}

// ------------------- INDEX BUILDERS -------------------
function buildUsernameToUser(contest) {
    const idx = new Map();
    for (const k of Object.keys(contest.Users || {})) {
        const u = contest.Users[k];
        if (u?.Username) idx.set(u.Username.trim(), u);
    }
    return idx;
}

function buildProblemCodeToId(contest) {
    const idx = new Map();
    for (const pid of Object.keys(contest.ProblemsInfo || {})) {
        const p = contest.ProblemsInfo[pid];
        if (p?.Code) idx.set(p.Code.trim(), Number(pid));
    }
    return idx;
}

function ensureProblemBucket(userObj, problemId, problemCode) {
    if (!userObj.Problems) userObj.Problems = {};
    if (!userObj.Problems[problemId]) {
        userObj.Problems[problemId] = { Id: problemId, Code: problemCode, Submissions: [] };
    }
    return userObj.Problems[problemId];
}

function mergeSubmissions(problemBucket, newSubs) {
    const existing = problemBucket.Submissions || [];
    const seen = new Set(existing.map((s) => s?.Id).filter((x) => x != null));
    for (const s of newSubs) {
        if (!s || s.Id == null) continue;
        if (seen.has(s.Id)) continue;
        existing.push(s);
        seen.add(s.Id);
    }
    // keep time-ascending
    existing.sort((a, b) => new Date(a.Time).getTime() - new Date(b.Time).getTime());
    problemBucket.Submissions = existing;
}

// ------------------- NEW: Problem Set helpers -------------------

/**
 * Build a flat list of { username, problemCode, setStart, setEnd } tasks,
 * filtering out:
 *   1. Expired problem sets
 *   2. Problems not in ProblemsInfo (not in contest)
 *   3. (Later) problems already scored 100 & problems not solved by user
 */
function buildUserAllowedTasks(courses, codeToProblemId) {
    // username -> [{ code, setStart, setEnd, setName }]
    const userTasks = new Map();
    const allUsers = new Set();
    const now = Date.now();

    for (const course of courses) {
        const users = (course.users || []).map(x => (x || "").trim()).filter(Boolean);
        const problemSets = course.problemSets || [];

        for (const set of problemSets) {
            const setStart = set.start;
            const setEnd = set.end;
            const setName = set.name || "unnamed";

            // SKIP: expired problem sets
            if (new Date(setEnd).getTime() < now) {
                continue;
            }

            const problems = (set.problems || []).map(x => (x || "").trim()).filter(Boolean);

            for (const u of users) {
                allUsers.add(u);
                if (!userTasks.has(u)) userTasks.set(u, []);

                for (const code of problems) {
                    // SKIP: problem not in contest ProblemsInfo
                    if (!codeToProblemId.has(code)) continue;

                    userTasks.get(u).push({
                        code,
                        problemId: codeToProblemId.get(code),
                        setStart,
                        setEnd,
                        setName,
                    });
                }
            }
        }
    }

    return {
        allUsers: Array.from(allUsers).sort((a, b) => a.localeCompare(b)),
        userTasks,
    };
}

/**
 * Check if user already has a Score>=100 submission within the set's time window.
 */
function hasFullScoreInWindow(userObj, problemId, startIso, endIso) {
    const subs = userObj.Problems?.[problemId]?.Submissions || [];
    if (!subs.length) return false;

    const start = new Date(startIso).getTime();
    const end = new Date(endIso).getTime();

    return subs.some(s =>
        s.Score >= 100 &&
        new Date(s.Time).getTime() >= start &&
        new Date(s.Time).getTime() <= end
    );
}

/**
 * Get the latest submission time for a user+problem within a date range.
 * Returns the ISO string of the latest submission, or null if none found.
 */
function getLatestSubmissionTime(userObj, problemId, startIso, endIso) {
    const subs = userObj.Problems?.[problemId]?.Submissions || [];
    if (!subs.length) return null;

    const start = new Date(startIso).getTime();
    const end = new Date(endIso).getTime();

    let latest = null;
    let latestTime = -Infinity;

    for (const s of subs) {
        const t = new Date(s.Time).getTime();
        if (t >= start && t <= end && t > latestTime) {
            latestTime = t;
            latest = s.Time;
        }
    }

    return latest;
}

// ------------------- STEP 2: PROFILE -> SOLVED PROBLEM CODES -------------------
async function extractSolvedProblemCodesFromUserProfile(page, username) {
    const url = `https://www.spoj.com/EIUPROGR/users/${encodeURIComponent(username)}/`;
    await safeGoto(page, url, "#content table tr");

    const codes = await withRetry(`extract solved problems for ${username}`, async () => {
        return await page.evaluate(() => {
            const out = [];
            const links = Array.from(document.querySelectorAll("a[href*='/EIUPROGR/status/']"));

            for (const a of links) {
                const href = a.getAttribute("href") || "";
                const m = href.match(/\/EIUPROGR\/status\/([^,\/]+),/);
                if (m && m[1]) out.push(m[1].trim());
            }

            return out;
        });
    });

    return [...new Set(codes)].filter((c) => c && c.length >= 2);
}

// ------------------- STEP 3: STATUS TABLE PARSING + PAGINATION -------------------
async function parseUserProblemStatusRows(page) {
    return await withRetry("parse status rows", async () => {
        return await page.evaluate(() => {
            const table =
                document.querySelector("table.problems") || null;

            if (!table) return [];

            const rows = Array.from(table.querySelectorAll("tr")).slice(1);
            const parsed = [];

            for (const tr of rows) {
                const tds = Array.from(tr.querySelectorAll("td"));
                if (tds.length < 6) continue;

                const txt = (i) => (tds[i]?.innerText || "").trim();

                const idText = txt(0);
                const dateText = txt(1);
                const resultText = txt(3);
                const timeText = txt(4);
                const langText = txt(6);

                const id = Number((idText || "").replace(/[^\d]/g, ""));
                const runTime = Number((timeText || "").replace(/[^\d.]/g, ""));

                parsed.push({
                    Id: Number.isNaN(id) ? null : id,
                    DateText: dateText,
                    ResultText: resultText,
                    RunTime: Number.isNaN(runTime) ? null : runTime,
                    LangText: langText,
                });
            }

            return parsed;
        });
    });
}

async function hasNextPage(page) {
    return await withRetry("hasNextPage", async () => {
        return await page.evaluate(() => {
            const nav = document.querySelector("table.navigation");
            if (!nav) return false;

            const pagerLinks = Array.from(nav.querySelectorAll("a.pager_link"));
            if (pagerLinks.length === 0) return false;

            const hasNext = pagerLinks.some(a => {
                const t = (a.textContent || "").trim().toLowerCase();
                return t === "next" || t === ">" || t === "›" || t === "»" || t === ">>";
            });

            return hasNext;
        });
    });
}

async function clickNextPage(page) {
    const ok = await withRetry("clickNextPage", async () => {
        const clicked = await page.evaluate(() => {
            const nav = document.querySelector("table.navigation");
            if (!nav) return false;

            const pagerLinks = Array.from(nav.querySelectorAll("a.pager_link"));
            if (!pagerLinks.length) return false;

            const norm = (x) => (x.textContent || "").trim().toLowerCase();

            let a = pagerLinks.find(x => norm(x) === "next");
            if (a) { a.click(); return true; }

            a = pagerLinks.find(x => {
                const t = norm(x);
                return t === ">" || t === "›" || t === "»" || t === ">>";
            });
            if (a) { a.click(); return true; }

            const rightCell = nav.querySelector("td[align='right']");
            if (rightCell) {
                const rightLinks = Array.from(rightCell.querySelectorAll("a.pager_link"));
                const nextLike = rightLinks.find(x => {
                    const t = norm(x);
                    return t === "next" || t === ">" || t === "›" || t === "»" || t === ">>";
                });
                if (nextLike) { nextLike.click(); return true; }
            }

            return false;
        });

        return clicked;
    });

    if (!ok) return false;

    await page
        .waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 })
        .catch(() => { });
    await politeDelay();
    return true;
}

async function scrapeNewSubmissionsForUserProblem(page, username, problemCode, lowerBoundIso, upperBoundIso) {
    const url = `https://www.spoj.com/EIUPROGR/status/${encodeURIComponent(problemCode)},${encodeURIComponent(
        username
    )}/`;

    await safeGoto(page, url);

    const newSubs = [];
    let stopAll = false;
    const lower = new Date(lowerBoundIso).getTime();
    const upper = new Date(upperBoundIso).getTime();

    // The table is sorted latest -> oldest, guard reduced to 50
    for (let guard = 0; guard < 50; guard++) {
        const rows = await parseUserProblemStatusRows(page);
        if (!rows.length) break;

        for (const r of rows) {
            const iso = parseSpojDateToIso(r.DateText);
            if (!iso) continue;
            const isoTime = new Date(iso).getTime();

            // ✅ Early stop (sorted newest -> oldest)
            if (isoTime <= lower) {
                stopAll = true;
                break;
            }
            // Only collect submissions within safe window
            if (isoTime > lower && isoTime <= upper) {
                newSubs.push({
                    Id: r.Id,
                    Time: iso,
                    Score: parseResultToScore(r.ResultText),
                    RunTime: r.RunTime,
                    Language: normalizeLanguage(r.LangText),
                });
            }

        }

        if (stopAll) break;

        const next = await hasNextPage(page);
        if (!next) break;

        const clicked = await clickNextPage(page);
        if (!clicked) break;
    }

    return newSubs;
}

// ------------------- GIT PUSH -------------------
function pushToGit() {
    try {
        console.log("--- Starting Git Sync ---");
        execSync("git add Data.json", { cwd: repoFolder });

        try {
            execSync("git commit --amend --no-edit", { cwd: repoFolder });
        } catch {
            console.log("Nothing to commit (file likely unchanged).");
        }

        execSync("git push --force", { cwd: repoFolder });
        console.log("--- Git Sync Complete ---");
    } catch (e) {
        console.error("Git Push Failed!");
        throw e;
    }
}

// ------------------- MAIN -------------------
async function main() {
    const contest = loadJson(jsonPath);
    const COURSES = require("./StudentCourses.json");

    if (!contest.LastUpdated) {
        console.error("Data.json has no LastUpdated. Cannot do incremental scrape.");
        process.exit(1);
    }

    const previousLastUpdatedIso = new Date(contest.LastUpdated).toISOString();
    const scrapeStartTime = new Date();
    const scrapeStartTimeIso = scrapeStartTime.toISOString();

    const semesterStartIso = new Date(SEMESTER_START_ISO).toISOString();
    const semesterEndIso = new Date(SEMESTER_END_ISO).toISOString();

    if (!FORCE_SCRAPE && scrapeStartTime.getTime() > new Date(semesterEndIso).getTime()) {
        console.log(`[Skip] Today is after semester end (${semesterEndIso}). No scraping.`);
        process.exit(0);
    }

    console.log(`[Window] previousLastUpdated = ${previousLastUpdatedIso}`);
    console.log(`[Window] semesterStart       = ${semesterStartIso}`);
    console.log(`[Window] scrapeStart         = ${scrapeStartTimeIso}`);
    console.log(`[Window] semesterEnd         = ${semesterEndIso}`);
    console.log(`[Info] Lower bounds are now computed per-problem (based on latest submission or set start).`);

    const usernameToUser = buildUsernameToUser(contest);
    const codeToProblemId = buildProblemCodeToId(contest);

    // Build tasks from new problem set structure (filters expired sets + unknown problems)
    const { allUsers: targetUsernames, userTasks } = buildUserAllowedTasks(COURSES, codeToProblemId);
    console.log(`[Info] Will process ${targetUsernames.length} target users.`);

    // One browser, one page only, close at end
    const { browser, page } = await connect({
        headless: false,
        turnstile: true,
    });

    try {
        await page.setViewport({ width: 1366, height: 768 });

        // Block unnecessary resources to speed up page loads
        // await page.setRequestInterception(true);
        // page.on("request", (req) => {
        //     const type = req.resourceType();
        //     if (["image", "stylesheet", "font", "media"].includes(type)) {
        //         req.abort();
        //     } else {
        //         req.continue();
        //     }
        // });

        let totalSkippedExpired = 0;
        let totalSkippedFullScore = 0;
        let totalSkippedNotSolved = 0;
        let totalCrawled = 0;
        let totalMerged = 0;

        for (let userIdx = 0; userIdx < targetUsernames.length; userIdx++) {
            const username = targetUsernames[userIdx];
            const elapsed = ((Date.now() - scrapeStartTime.getTime()) / 1000 / 60).toFixed(1);
            console.log(`\n[User ${userIdx + 1}/${targetUsernames.length}] ${username} (elapsed: ${elapsed}m)`);

            const userObj = usernameToUser.get(username);
            if (!userObj) {
                console.warn(`  - Skipped: username not found in Data.json: ${username}`);
                continue;
            }

            const tasks = userTasks.get(username) || [];
            if (!tasks.length) {
                console.log("  - No active problem sets for this user.");
                continue;
            }

            // ---- LAYER 1: Solved-only filter (1 request per user) ----
            const solvedCodes = await extractSolvedProblemCodesFromUserProfile(page, username);
            const solvedSet = new Set(solvedCodes);
            console.log(`  - Profile: ${solvedCodes.length} solved problems found.`);

            let userMerged = 0;

            // Group tasks by unique problem code to avoid duplicate crawls
            // (a user might have same problem in multiple sets)
            const problemTasksMap = new Map(); // code -> [task, ...]
            for (const task of tasks) {
                if (!problemTasksMap.has(task.code)) problemTasksMap.set(task.code, []);
                problemTasksMap.get(task.code).push(task);
            }

            for (const [code, codeTasks] of problemTasksMap) {
                // ---- LAYER 2: Inner join with solved problems ----
                if (!solvedSet.has(code)) {
                    totalSkippedNotSolved++;
                    continue;
                }

                // ---- LAYER 3: Skip if already scored 100 in ALL relevant time windows ----
                // Only need to crawl if at least one time window doesn't have a full score yet
                const needsCrawlTasks = codeTasks.filter(
                    t => !hasFullScoreInWindow(userObj, t.problemId, t.setStart, t.setEnd)
                );

                if (!needsCrawlTasks.length) {
                    totalSkippedFullScore++;
                    continue;
                }

                // ---- CRAWL: Passed all filters ----
                // Compute per-problem bounds from the union of all active time windows
                // Find the earliest setStart and latest setEnd across all tasks needing crawl
                const earliestSetStart = needsCrawlTasks.reduce((min, t) => {
                    const ts = new Date(t.setStart).getTime();
                    return ts < min ? ts : min;
                }, Infinity);
                const latestSetEnd = needsCrawlTasks.reduce((max, t) => {
                    const ts = new Date(t.setEnd).getTime();
                    return ts > max ? ts : max;
                }, -Infinity);

                const problemId = needsCrawlTasks[0].problemId;

                // Per-problem lower bound:
                //   - If user has existing submissions for this problem, use the latest submission time
                //     (they were already scraped up to that point)
                //   - If no existing submissions, use the set's start time to catch everything
                const latestSubTime = getLatestSubmissionTime(
                    userObj, problemId,
                    new Date(earliestSetStart).toISOString(),
                    new Date(latestSetEnd).toISOString()
                );

                const taskLowerBoundIso = latestSubTime
                    ? latestSubTime                                  // resume from last known submission
                    : new Date(earliestSetStart).toISOString();      // no submissions yet -> scrape from set start

                // Per-problem upper bound = min(scrapeStart, latestSetEnd)
                const taskUpperBoundIso =
                    scrapeStartTime.getTime() < latestSetEnd
                        ? scrapeStartTimeIso
                        : new Date(latestSetEnd).toISOString();

                totalCrawled++;
                console.log(`    [Problem] ${code} (lower=${taskLowerBoundIso}, upper=${taskUpperBoundIso})`);

                const newSubs = await scrapeNewSubmissionsForUserProblem(
                    page, username, code, taskLowerBoundIso, taskUpperBoundIso
                );

                if (!newSubs.length) {
                    console.log("      -> no new submissions.");
                    continue;
                }

                // Merge into the single problem bucket (problemId is the same across tasks)
                const bucket = ensureProblemBucket(userObj, problemId, code);
                mergeSubmissions(bucket, newSubs);
                userMerged += newSubs.length;
                totalMerged += newSubs.length;

                console.log(`      -> merged ${newSubs.length} new submissions.`);
            }

            console.log(`  => Total merged for ${username}: ${userMerged}`);

            // Save after each user for resume-safety
            saveJson(jsonPath, contest);
        }

        // Final summary
        console.log(`\n========== SUMMARY ==========`);
        console.log(`  Total users:            ${targetUsernames.length}`);
        console.log(`  Skipped (not solved):   ${totalSkippedNotSolved}`);
        console.log(`  Skipped (score >= 100): ${totalSkippedFullScore}`);
        console.log(`  Actually crawled:       ${totalCrawled}`);
        console.log(`  Total submissions merged: ${totalMerged}`);
        const totalElapsed = ((Date.now() - scrapeStartTime.getTime()) / 1000 / 60).toFixed(1);
        console.log(`  Total time:             ${totalElapsed} minutes`);
        console.log(`==============================`);

        // Update LastUpdated
        contest.LastUpdated = getCsharpFormattedDate(scrapeStartTime);
        saveJson(jsonPath, contest);
        console.log(`\n[Saved] Updated Data.json. New LastUpdated=${contest.LastUpdated}`);

        // Push to git
        pushToGit();
    } finally {
        await browser.close();
    }
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});