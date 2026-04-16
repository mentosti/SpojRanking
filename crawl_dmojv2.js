const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ------------------- CONFIG -------------------
const BASE_URL = "https://oj.eiu.edu.vn";
const DATA_DIR = path.join(__dirname, "data");
const COURSES_PATH = path.join(__dirname, "StudentCoursesQ3.json");
const REPO_FOLDER = __dirname;

const FORCE_SCRAPE = false;

// DMOJ public API rate limit: be conservative
const MIN_DELAY_MS = 700;
const MAX_RETRIES = 3;

// If true, keep collecting submissions even after a user gets AC in a window.
// If false, stop collecting later submissions for that user-window once AC is seen.
const KEEP_SUBMISSIONS_AFTER_AC = false;

// ------------------- UTILS -------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadJsonSafe(p) {
    if (!fs.existsSync(p)) return null;
    const txt = fs.readFileSync(p, "utf-8");
    if (!txt.trim()) return null;
    try {
        return JSON.parse(txt);
    } catch {
        console.warn(`[Warn] Failed to parse JSON: ${p}`);
        return null;
    }
}

function saveJson(p, obj) {
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf-8");
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function courseFileName(courseName) {
    return courseName.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "") + ".json";
}

function toMs(v) {
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? null : t;
}

function normalizeUsername(s) {
    return (s || "").trim().toLowerCase();
}

function normalizeProblemCode(s) {
    return (s || "").trim().toLowerCase();
}

// ------------------- API CLIENT -------------------
async function fetchApi(endpoint, params = {}) {
    const url = new URL(endpoint, BASE_URL);
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.append(k, v);
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const resp = await fetch(url.toString());
            if (!resp.ok) {
                const body = await resp.text().catch(() => "");
                throw new Error(`HTTP ${resp.status}: ${resp.statusText} - ${body.slice(0, 200)}`);
            }

            const json = await resp.json();
            if (json.error) {
                throw new Error(`API Error: ${JSON.stringify(json.error)}`);
            }

            return json.data;
        } catch (err) {
            console.warn(`  [Retry ${attempt}/${MAX_RETRIES}] ${url}: ${err.message}`);
            if (attempt === MAX_RETRIES) throw err;
            await sleep(1000 * Math.pow(2, attempt - 1));
        }
    }
}

async function fetchAllPages(endpoint, params = {}) {
    const allObjects = [];
    let page = 1;

    while (true) {
        const data = await fetchApi(endpoint, { ...params, page: String(page) });
        const objects = data?.objects || [];
        if (objects.length === 0) break;

        allObjects.push(...objects);
        console.log(`    Page ${page}: +${objects.length} (total: ${allObjects.length})`);

        if (!data.has_more) break;
        page++;
        await sleep(MIN_DELAY_MS);
    }

    return allObjects;
}

// ------------------- COURSE TASK BUILDING -------------------
/**
 * Build:
 * - problemToCourseEntries: Map<problemLower, Array<{ courseName, setStart, setEnd, setName, originalCode }>>
 * - courseUsers: Map<courseName, Set<usernameLower>>
 * - courseActiveProblems: Map<courseName, Map<problemLower, originalCode>>
 */
function buildTasksFromCourses(courses) {
    const now = Date.now();
    const problemToCourseEntries = new Map();
    const courseUsers = new Map();
    const courseActiveProblems = new Map();

    let totalSkippedExpired = 0;

    for (const course of courses) {
        const courseName = course.name;
        const users = (course.users || []).map(normalizeUsername).filter(Boolean);

        courseUsers.set(courseName, new Set(users));
        if (!courseActiveProblems.has(courseName)) {
            courseActiveProblems.set(courseName, new Map());
        }

        for (const set of course.problemSets || []) {
            const setEndMs = toMs(set.end);

            if (!FORCE_SCRAPE && setEndMs != null && setEndMs < now) {
                totalSkippedExpired++;
                console.log(`  [Skip] Expired: "${set.name}" in ${courseName} (ended ${set.end})`);
                continue;
            }

            const setStart = set.start;
            const setEnd = set.end;
            const setName = set.name || "unnamed";
            const problems = (set.problems || []).map((p) => (p || "").trim()).filter(Boolean);

            for (const code of problems) {
                const lowerCode = normalizeProblemCode(code);

                if (!problemToCourseEntries.has(lowerCode)) {
                    problemToCourseEntries.set(lowerCode, []);
                }

                problemToCourseEntries.get(lowerCode).push({
                    courseName,
                    setStart,
                    setEnd,
                    setName,
                    originalCode: code,
                });

                courseActiveProblems.get(courseName).set(lowerCode, code);
            }
        }
    }

    console.log(`  [Info] Skipped ${totalSkippedExpired} expired problem set(s).`);
    return { problemToCourseEntries, courseUsers, courseActiveProblems };
}

// ------------------- EXISTING DATA HELPERS -------------------
function ensureCourseDataShape(courseData, courseName) {
    if (!courseData || typeof courseData !== "object") {
        return { courseName, lastUpdated: null, users: {} };
    }
    if (!courseData.users || typeof courseData.users !== "object") {
        courseData.users = {};
    }
    if (!courseData.courseName) {
        courseData.courseName = courseName;
    }
    if (!("lastUpdated" in courseData)) {
        courseData.lastUpdated = null;
    }
    return courseData;
}

function ensureBucket(courseData, username, problemCode) {
    if (!courseData.users[username]) {
        courseData.users[username] = { username, problems: {} };
    }
    if (!courseData.users[username].problems) {
        courseData.users[username].problems = {};
    }
    if (!courseData.users[username].problems[problemCode]) {
        courseData.users[username].problems[problemCode] = {
            code: problemCode,
            submissions: [],
        };
    }
    return courseData.users[username].problems[problemCode];
}

function mergeSubmissions(existing, newSubs) {
    const seen = new Set((existing || []).map((s) => s?.id).filter((x) => x != null));

    for (const s of newSubs) {
        if (!s || s.id == null || seen.has(s.id)) continue;
        existing.push(s);
        seen.add(s.id);
    }

    existing.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    return existing;
}

function getSubsInWindow(courseData, username, problemCode, startIso, endIso) {
    const subs = courseData?.users?.[username]?.problems?.[problemCode]?.submissions || [];
    if (!subs.length) return [];

    const start = toMs(startIso);
    const end = toMs(endIso);
    if (start == null || end == null) return [];

    return subs.filter((s) => {
        const t = toMs(s.time);
        return t != null && t >= start && t <= end;
    });
}

function hasACInWindow(courseData, username, problemCode, startIso, endIso) {
    const subs = getSubsInWindow(courseData, username, problemCode, startIso, endIso);
    return subs.some((s) => s.result === "AC");
}

function getLatestSubmissionTimeInWindow(courseData, username, problemCode, startIso, endIso) {
    const subs = getSubsInWindow(courseData, username, problemCode, startIso, endIso);
    if (!subs.length) return null;

    let latest = null;
    let latestMs = -Infinity;

    for (const s of subs) {
        const t = toMs(s.time);
        if (t != null && t > latestMs) {
            latestMs = t;
            latest = s.time;
        }
    }

    return latest;
}

function getEarliestACSubmissionTimeInWindow(courseData, username, problemCode, startIso, endIso) {
    const subs = getSubsInWindow(courseData, username, problemCode, startIso, endIso)
        .filter((s) => s.result === "AC");
    if (!subs.length) return null;

    let earliest = null;
    let earliestMs = Infinity;

    for (const s of subs) {
        const t = toMs(s.time);
        if (t != null && t < earliestMs) {
            earliestMs = t;
            earliest = s.time;
        }
    }

    return earliest;
}

// ------------------- PER-PROBLEM RUNTIME PLAN -------------------
/**
 * For one problem, build per-user entries:
 * Map<usernameLower, Array<entryState>>
 *
 * entryState = {
 *   courseName,
 *   originalCode,
 *   setName,
 *   setStart,
 *   setEnd,
 *   startMs,
 *   endMs,
 *   done,
 *   doneReason,
 *   acTimeMs,
 *   lowerBoundMs,
 *   latestKnownTime
 * }
 */
function buildRelevantUserEntries(problemCode, courseEntries, courseUsers, courseDataMap, scrapeStartMs) {
    const relevantUsers = new Map();

    for (const entry of courseEntries) {
        const courseName = entry.courseName;
        const users = courseUsers.get(courseName) || new Set();
        const courseData = courseDataMap.get(courseName);

        for (const username of users) {
            const startMs = toMs(entry.setStart);
            const endMsRaw = toMs(entry.setEnd);
            const endMs = endMsRaw == null ? null : Math.min(endMsRaw, scrapeStartMs);

            if (startMs == null || endMs == null || startMs > endMs) continue;

            const hasOldAC = hasACInWindow(
                courseData,
                username,
                entry.originalCode,
                entry.setStart,
                entry.setEnd
            );

            const earliestACTime = getEarliestACSubmissionTimeInWindow(
                courseData,
                username,
                entry.originalCode,
                entry.setStart,
                entry.setEnd
            );

            const latestKnownTime = getLatestSubmissionTimeInWindow(
                courseData,
                username,
                entry.originalCode,
                entry.setStart,
                entry.setEnd
            );

            const lowerBoundMs = latestKnownTime ? toMs(latestKnownTime) : startMs;

            const state = {
                courseName,
                originalCode: entry.originalCode,
                setName: entry.setName,
                setStart: entry.setStart,
                setEnd: entry.setEnd,
                startMs,
                endMs,
                done: hasOldAC,
                doneReason: hasOldAC ? "already_ac_in_existing_data" : null,
                acTimeMs: earliestACTime ? toMs(earliestACTime) : null,
                latestKnownTime,
                lowerBoundMs,
            };

            if (!relevantUsers.has(username)) relevantUsers.set(username, []);
            relevantUsers.get(username).push(state);
        }
    }

    return relevantUsers;
}

function summarizeRelevantEntries(relevantUsers) {
    let totalPairs = 0;
    let donePairs = 0;

    for (const entries of relevantUsers.values()) {
        for (const entry of entries) {
            totalPairs++;
            if (entry.done) donePairs++;
        }
    }

    return { totalPairs, donePairs, allDone: totalPairs > 0 && totalPairs === donePairs };
}

function countOpenEntries(relevantUsers) {
    let count = 0;
    for (const entries of relevantUsers.values()) {
        for (const entry of entries) {
            if (!entry.done) count++;
        }
    }
    return count;
}

// ------------------- GIT PUSH -------------------
function pushToGit() {
    try {
        console.log("\n--- Starting Git Sync ---");
        execSync("git add data/", { cwd: REPO_FOLDER });

        try {
            execSync('git commit -m "Update DMOJ data"', { cwd: REPO_FOLDER });
        } catch {
            console.log("Nothing to commit (files likely unchanged).");
            return;
        }

        execSync("git push", { cwd: REPO_FOLDER });
        console.log("--- Git Sync Complete ---");
    } catch (e) {
        console.error("Git Push Failed!", e.message);
    }
}

// ------------------- MAIN -------------------
async function main() {
    const courses = require(COURSES_PATH);
    ensureDir(DATA_DIR);

    const startTime = new Date();
    const startTimeIso = startTime.toISOString();
    const scrapeStartMs = startTime.getTime();

    console.log(`\n${"=".repeat(60)}`);
    console.log(`  DMOJ Incremental Crawler - ${startTimeIso}`);
    console.log(`${"=".repeat(60)}`);
    console.log(`[Config] Base URL:     ${BASE_URL}`);
    console.log(`[Config] Courses:      ${courses.length}`);
    console.log(`[Config] Data Dir:     ${DATA_DIR}`);
    console.log(`[Config] Force scrape: ${FORCE_SCRAPE}`);
    console.log(`[Config] Keep after AC:${KEEP_SUBMISSIONS_AFTER_AC}\n`);

    // ---- Step 1: Build task structure ----
    console.log("[Step 1] Building task list from StudentCoursesQ3.json...");
    const { problemToCourseEntries, courseUsers, courseActiveProblems } =
        buildTasksFromCourses(courses);

    const uniqueProblems = Array.from(problemToCourseEntries.keys()).sort();

    console.log(`\n[Info] ${uniqueProblems.length} unique active problem(s) to query.`);
    for (const [name, users] of courseUsers) {
        const problemCount = courseActiveProblems.get(name)?.size || 0;
        console.log(`  - ${name}: ${users.size} users, ${problemCount} active problems`);
    }

    // ---- Step 2: Load existing per-course data ----
    console.log("\n[Step 2] Loading existing course data...");
    const courseDataMap = new Map();

    for (const course of courses) {
        const filePath = path.join(DATA_DIR, courseFileName(course.name));
        const existing = loadJsonSafe(filePath);
        const courseData = ensureCourseDataShape(existing, course.name);

        if (existing) {
            console.log(`  Loaded: ${courseFileName(course.name)}`);
        } else {
            console.log(`  New:    ${courseFileName(course.name)}`);
        }

        courseDataMap.set(course.name, courseData);
    }

    // ---- Step 3: Fetch submissions per problem ----
    console.log("\n[Step 3] Fetching submissions from DMOJ API...");

    let totalApiCalls = 0;
    let totalSubsFetched = 0;
    let totalMerged = 0;
    let skippedAllAC = 0;
    let skippedNotFound = 0;
    let skippedByLowerBound = 0;
    let skippedAfterAC = 0;
    let skippedOutsideWindow = 0;
    let skippedIrrelevantUser = 0;

    for (let pi = 0; pi < uniqueProblems.length; pi++) {
        const problemCodeLower = uniqueProblems[pi];
        const courseEntries = problemToCourseEntries.get(problemCodeLower) || [];
        const displayCode = courseEntries[0]?.originalCode || problemCodeLower;
        const elapsed = ((Date.now() - scrapeStartMs) / 1000 / 60).toFixed(1);

        console.log(
            `\n[Problem ${pi + 1}/${uniqueProblems.length}] ${displayCode} (${elapsed}m elapsed)`
        );

        // Build per-user per-window runtime plan
        const relevantUsers = buildRelevantUserEntries(
            problemCodeLower,
            courseEntries,
            courseUsers,
            courseDataMap,
            scrapeStartMs
        );

        const { totalPairs, donePairs, allDone } = summarizeRelevantEntries(relevantUsers);

        if (allDone && totalPairs > 0) {
            skippedAllAC++;
            console.log(`  [Skip] All ${totalPairs} user-window pair(s) already have AC.`);
            continue;
        }

        console.log(`  Open pairs: ${totalPairs - donePairs}/${totalPairs}`);

        // Fetch full problem submission list from API
        totalApiCalls++;
        let submissions;
        try {
            submissions = await fetchAllPages("/api/v2/submissions", {
                // safer to query using original code casing from course file
                problem: displayCode,
            });
        } catch (err) {
            console.error(`  [ERROR] Failed to fetch: ${err.message}`);
            if (err.message.includes("404")) {
                skippedNotFound++;
                console.log(`  Problem "${displayCode}" not found on DMOJ.`);
            }
            continue;
        }

        totalSubsFetched += submissions.length;
        console.log(`  Total raw submissions: ${submissions.length}`);

        let problemMerged = 0;

        // DMOJ API is assumed sorted oldest -> newest.
        for (const sub of submissions) {
            const subUser = normalizeUsername(sub.user);
            const subDateMs = toMs(sub.date);

            if (!subUser || subDateMs == null) continue;

            const userEntries = relevantUsers.get(subUser);
            if (!userEntries) {
                skippedIrrelevantUser++;
                continue;
            }

            // normalized submission record
            const subRecord = {
                id: sub.id,
                time: sub.date,
                points: sub.points ?? null,
                result: sub.result ?? null,
                language: sub.language ?? null,
                runTime: sub.time ?? null,
                memory: sub.memory ?? null,
            };

            for (const entry of userEntries) {
                // Already done because old AC or AC found earlier in this run
                if (entry.done && !KEEP_SUBMISSIONS_AFTER_AC) {
                    skippedAfterAC++;
                    continue;
                }

                // Outside this assignment window
                if (subDateMs < entry.startMs || subDateMs > entry.endMs) {
                    skippedOutsideWindow++;
                    continue;
                }

                // Incremental lower bound:
                // If we already have submissions up to time T, ignore submissions <= T.
                if (entry.lowerBoundMs != null && subDateMs <= entry.lowerBoundMs) {
                    skippedByLowerBound++;
                    continue;
                }

                const courseData = courseDataMap.get(entry.courseName);
                const bucket = ensureBucket(courseData, subUser, entry.originalCode);
                const beforeCount = bucket.submissions.length;

                mergeSubmissions(bucket.submissions, [subRecord]);

                if (bucket.submissions.length > beforeCount) {
                    problemMerged++;
                    totalMerged++;

                    // If this new submission is AC, mark this user-window as done.
                    if (subRecord.result === "AC" && !KEEP_SUBMISSIONS_AFTER_AC) {
                        entry.done = true;
                        entry.doneReason = "ac_found_in_current_run";
                        entry.acTimeMs = subDateMs;
                    }

                    // Advance lower bound so later submissions in the same run
                    // do not reconsider older/equal timestamps.
                    if (entry.lowerBoundMs == null || subDateMs > entry.lowerBoundMs) {
                        entry.lowerBoundMs = subDateMs;
                    }
                } else {
                    // Duplicate ID already stored. Still safe to advance lower bound.
                    if (entry.lowerBoundMs == null || subDateMs > entry.lowerBoundMs) {
                        entry.lowerBoundMs = subDateMs;
                    }

                    // If duplicate AC already exists and business rule says stop after AC,
                    // mark done as well.
                    if (subRecord.result === "AC" && !KEEP_SUBMISSIONS_AFTER_AC) {
                        entry.done = true;
                        entry.doneReason = entry.doneReason || "ac_already_present";
                        entry.acTimeMs = subDateMs;
                    }
                }
            }

            // Optional micro-optimization: if all pairs are done, we can stop local processing.
            if (!KEEP_SUBMISSIONS_AFTER_AC && countOpenEntries(relevantUsers) === 0) {
                console.log("  All open user-window pairs are now done. Stop processing this problem.");
                break;
            }
        }

        console.log(`  -> Merged ${problemMerged} new submission(s).`);

        // Save after each problem for resume safety
        for (const course of courses) {
            const courseData = courseDataMap.get(course.name);
            courseData.lastUpdated = startTimeIso;

            const filePath = path.join(DATA_DIR, courseFileName(course.name));
            saveJson(filePath, courseData);
        }

        if (pi < uniqueProblems.length - 1) {
            await sleep(MIN_DELAY_MS);
        }
    }

    // ---- Step 4: Final save ----
    console.log("\n[Step 4] Final save...");
    for (const course of courses) {
        const courseData = courseDataMap.get(course.name);
        courseData.lastUpdated = startTimeIso;

        const filePath = path.join(DATA_DIR, courseFileName(course.name));
        saveJson(filePath, courseData);

        let userCount = Object.keys(courseData.users).length;
        let subCount = 0;
        for (const userObj of Object.values(courseData.users)) {
            const problems = userObj.problems || {};
            for (const p of Object.values(problems)) {
                subCount += (p.submissions || []).length;
            }
        }

        console.log(
            `  [Saved] ${courseFileName(course.name)} (${userCount} users, ${subCount} submissions)`
        );
    }

    // ---- Summary ----
    const totalElapsed = ((Date.now() - scrapeStartMs) / 1000 / 60).toFixed(1);
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  SUMMARY`);
    console.log(`${"=".repeat(60)}`);
    console.log(`  Unique problems queried:        ${uniqueProblems.length}`);
    console.log(`  API calls made:                 ${totalApiCalls}`);
    console.log(`  Submissions fetched:            ${totalSubsFetched}`);
    console.log(`  New submissions merged:         ${totalMerged}`);
    console.log(`  Skipped (all pairs already AC): ${skippedAllAC}`);
    console.log(`  Skipped (not found on DMOJ):    ${skippedNotFound}`);
    console.log(`  Skipped by lower bound:         ${skippedByLowerBound}`);
    console.log(`  Skipped after AC:               ${skippedAfterAC}`);
    console.log(`  Skipped outside window:         ${skippedOutsideWindow}`);
    console.log(`  Skipped irrelevant user:        ${skippedIrrelevantUser}`);
    console.log(`  Total time:                     ${totalElapsed} minutes`);
    console.log(`${"=".repeat(60)}`);

    // ---- Step 5: Git push ----
    // pushToGit();
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});