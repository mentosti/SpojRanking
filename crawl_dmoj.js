const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ------------------- CONFIG -------------------
const BASE_URL = "https://oj.eiu.edu.vn";
const DATA_DIR = path.join(__dirname, "data");
const COURSES_PATH = path.join(__dirname, "StudentCoursesQ3.json");
const REPO_FOLDER = __dirname;

// If true, ignore expired problem sets and scrape anyway
const FORCE_SCRAPE = false;

// Rate limiting: DMOJ allows 90 req/min. Be conservative.
const MIN_DELAY_MS = 700; // ~85 req/min max
const MAX_RETRIES = 3;

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

/**
 * Convert course name to a safe file name: "CSE 202" -> "CSE_202.json"
 */
function courseFileName(courseName) {
    return courseName.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "") + ".json";
}

// ------------------- API CLIENT -------------------

/**
 * Fetch a single API page. Returns the `data` object from the response.
 */
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

/**
 * Fetch all pages of a paginated list endpoint.
 * Returns the combined array of all objects across pages.
 */
async function fetchAllPages(endpoint, params = {}) {
    const allObjects = [];
    let page = 1;

    while (true) {
        const data = await fetchApi(endpoint, { ...params, page: String(page) });
        if (!data || !data.objects || data.objects.length === 0) break;

        allObjects.push(...data.objects);
        console.log(`    Page ${page}: +${data.objects.length} (total: ${allObjects.length})`);

        if (!data.has_more) break;
        page++;
        await sleep(MIN_DELAY_MS);
    }

    return allObjects;
}

// ------------------- TASK BUILDING -------------------

/**
 * Build the mapping structures from StudentCourses.json:
 *
 * problemToCourseEntries:
 *   Map<lowercaseProblemCode, Array<{
 *     courseName, setStart, setEnd, setName, originalCode
 *   }>>
 *
 * courseUsers:
 *   Map<courseName, Set<lowercaseUsername>>
 *
 * courseActiveProblems:
 *   Map<courseName, Map<lowercaseProblemCode, originalCode>>
 */
function buildTasksFromCourses(courses) {
    const now = Date.now();
    const problemToCourseEntries = new Map();
    const courseUsers = new Map();
    const courseActiveProblems = new Map();

    let totalSkippedExpired = 0;

    for (const course of courses) {
        const courseName = course.name;
        const users = (course.users || []).map((u) => (u || "").trim().toLowerCase()).filter(Boolean);

        courseUsers.set(courseName, new Set(users));
        if (!courseActiveProblems.has(courseName)) courseActiveProblems.set(courseName, new Map());

        const problemSets = course.problemSets || [];

        for (const set of problemSets) {
            const setEndMs = new Date(set.end).getTime();

            // SKIP expired problem sets (unless FORCE_SCRAPE)
            if (!FORCE_SCRAPE && setEndMs < now) {
                totalSkippedExpired++;
                console.log(`  [Skip] Expired: "${set.name}" in ${courseName} (ended ${set.end})`);
                continue;
            }

            const setStart = set.start;
            const setEnd = set.end;
            const setName = set.name || "unnamed";
            const problems = (set.problems || []).map((p) => (p || "").trim()).filter(Boolean);

            for (const code of problems) {
                const lowerCode = code.toLowerCase();

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

// ------------------- MERGE LOGIC -------------------

/**
 * Check if a user already has an AC submission for a problem
 * within the given time window in the existing course data.
 */
function hasACInWindow(courseData, username, problemCode, startIso, endIso) {
    const subs = courseData?.users?.[username]?.problems?.[problemCode]?.submissions;
    if (!subs || !subs.length) return false;

    const start = new Date(startIso).getTime();
    const end = new Date(endIso).getTime();

    return subs.some((s) => {
        if (s.result !== "AC") return false;
        const t = new Date(s.time).getTime();
        return t >= start && t <= end;
    });
}

/**
 * Merge new submissions into the existing list, dedup by ID, sort by time ascending.
 * Mutates `existing` in place and returns it.
 */
function mergeSubmissions(existing, newSubs) {
    const seen = new Set(existing.map((s) => s.id));

    for (const s of newSubs) {
        if (s.id == null || seen.has(s.id)) continue;
        existing.push(s);
        seen.add(s.id);
    }

    // Keep time-ascending order
    existing.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    return existing;
}

/**
 * Ensure the user+problem bucket exists in course data.
 * Returns the problem bucket.
 */
function ensureBucket(courseData, username, problemCode) {
    if (!courseData.users[username]) {
        courseData.users[username] = { username, problems: {} };
    }
    if (!courseData.users[username].problems[problemCode]) {
        courseData.users[username].problems[problemCode] = {
            code: problemCode,
            submissions: [],
        };
    }
    return courseData.users[username].problems[problemCode];
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
    console.log(`\n${"=".repeat(50)}`);
    console.log(`  DMOJ Crawler - ${startTime.toISOString()}`);
    console.log(`${"=".repeat(50)}`);
    console.log(`[Config] Base URL:  ${BASE_URL}`);
    console.log(`[Config] Courses:   ${courses.length}`);
    console.log(`[Config] Data Dir:  ${DATA_DIR}\n`);

    // ---- Step 1: Build task structure ----
    console.log("[Step 1] Building task list from StudentCourses.json...");
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
        if (existing) {
            console.log(`  Loaded: ${courseFileName(course.name)}`);
            courseDataMap.set(course.name, existing);
        } else {
            console.log(`  New:    ${courseFileName(course.name)}`);
            courseDataMap.set(course.name, {
                courseName: course.name,
                lastUpdated: null,
                users: {},
            });
        }
    }

    // ---- Step 3: Fetch submissions per problem ----
    console.log("\n[Step 3] Fetching submissions from DMOJ API...");

    let totalApiCalls = 0;
    let totalSubsFetched = 0;
    let totalMerged = 0;
    let skippedAllAC = 0;
    let skippedNotFound = 0;

    for (let pi = 0; pi < uniqueProblems.length; pi++) {
        const problemCode = uniqueProblems[pi]; // lowercase
        const courseEntries = problemToCourseEntries.get(problemCode);
        const elapsed = ((Date.now() - startTime.getTime()) / 1000 / 60).toFixed(1);

        console.log(
            `\n[Problem ${pi + 1}/${uniqueProblems.length}] ${problemCode} (${elapsed}m elapsed)`
        );

        // ---- Optimization: Skip if ALL users in ALL courses already have AC ----
        let allDone = true;
        let totalRelevantPairs = 0;
        let acPairs = 0;

        for (const entry of courseEntries) {
            const courseData = courseDataMap.get(entry.courseName);
            const users = courseUsers.get(entry.courseName);

            for (const username of users) {
                totalRelevantPairs++;
                if (
                    hasACInWindow(
                        courseData,
                        username,
                        entry.originalCode,
                        entry.setStart,
                        entry.setEnd
                    )
                ) {
                    acPairs++;
                } else {
                    allDone = false;
                }
            }
        }

        if (allDone && totalRelevantPairs > 0) {
            skippedAllAC++;
            console.log(
                `  [Skip] All ${totalRelevantPairs} user-window pairs have AC.`
            );
            continue;
        }

        console.log(
            `  ${acPairs}/${totalRelevantPairs} pairs already have AC. Fetching...`
        );

        // ---- Fetch all submissions for this problem ----
        totalApiCalls++;
        let submissions;
        try {
            submissions = await fetchAllPages("/api/v2/submissions", {
                problem: problemCode,
            });
        } catch (err) {
            console.error(`  [ERROR] Failed to fetch: ${err.message}`);
            if (err.message.includes("404")) {
                skippedNotFound++;
                console.log(`  Problem "${problemCode}" not found on DMOJ.`);
            }
            continue;
        }

        totalSubsFetched += submissions.length;
        console.log(`  Total raw submissions: ${submissions.length}`);

        // ---- Build relevant users lookup ----
        // username (lowercase) -> [{courseName, setStart, setEnd, originalCode}]
        const relevantUsers = new Map();
        for (const entry of courseEntries) {
            const users = courseUsers.get(entry.courseName);
            for (const username of users) {
                if (!relevantUsers.has(username)) relevantUsers.set(username, []);
                relevantUsers.get(username).push(entry);
            }
        }

        // ---- Filter & merge submissions ----
        let problemMerged = 0;

        for (const sub of submissions) {
            // Skip submissions without points (CE, AB, etc.)
            if (sub.points == null) continue;

            const subUser = (sub.user || "").trim().toLowerCase();
            const subDateMs = new Date(sub.date).getTime();

            // Is this user relevant?
            const userEntries = relevantUsers.get(subUser);
            if (!userEntries) continue;

            // Build the normalized submission record
            const subRecord = {
                id: sub.id,
                time: sub.date,
                points: sub.points,
                result: sub.result,
                language: sub.language,
                runTime: sub.time,
                memory: sub.memory,
            };

            // Assign to each applicable course+window
            for (const entry of userEntries) {
                const windowStart = new Date(entry.setStart).getTime();
                const windowEnd = new Date(entry.setEnd).getTime();

                // Check time window
                if (subDateMs < windowStart || subDateMs > windowEnd) continue;

                // Merge into course data
                const courseData = courseDataMap.get(entry.courseName);
                const bucket = ensureBucket(
                    courseData,
                    subUser,
                    entry.originalCode
                );
                const beforeCount = bucket.submissions.length;
                mergeSubmissions(bucket.submissions, [subRecord]);

                if (bucket.submissions.length > beforeCount) {
                    problemMerged++;
                }
            }
        }

        totalMerged += problemMerged;
        console.log(`  -> Merged ${problemMerged} new submission(s).`);

        // Polite delay between problem queries
        if (pi < uniqueProblems.length - 1) {
            await sleep(MIN_DELAY_MS);
        }
    }

    // ---- Step 4: Save all course data ----
    console.log("\n[Step 4] Saving course data...");
    for (const course of courses) {
        const courseData = courseDataMap.get(course.name);
        courseData.lastUpdated = startTime.toISOString();

        const filePath = path.join(DATA_DIR, courseFileName(course.name));
        saveJson(filePath, courseData);

        // Count stats for this course
        const userCount = Object.keys(courseData.users).length;
        let subCount = 0;
        for (const u of Object.values(courseData.users)) {
            for (const p of Object.values(u.problems)) {
                subCount += (p.submissions || []).length;
            }
        }
        console.log(
            `  [Saved] ${courseFileName(course.name)} (${userCount} users, ${subCount} submissions)`
        );
    }

    // ---- Summary ----
    const totalElapsed = ((Date.now() - startTime.getTime()) / 1000 / 60).toFixed(1);
    console.log(`\n${"=".repeat(50)}`);
    console.log(`  SUMMARY`);
    console.log(`${"=".repeat(50)}`);
    console.log(`  Unique problems queried:     ${uniqueProblems.length}`);
    console.log(`  API calls made:              ${totalApiCalls}`);
    console.log(`  Submissions fetched:         ${totalSubsFetched}`);
    console.log(`  New submissions merged:      ${totalMerged}`);
    console.log(`  Skipped (all users have AC): ${skippedAllAC}`);
    console.log(`  Skipped (not found on DMOJ): ${skippedNotFound}`);
    console.log(`  Total time:                  ${totalElapsed} minutes`);
    console.log(`${"=".repeat(50)}`);

    // ---- Step 5: Git push ----
    //pushToGit();
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
