const { connect } = require('puppeteer-real-browser');
const path = require('path');
const fs = require('fs');
// NEW: Import execSync to run terminal commands
const { execSync } = require('child_process');

// --- Configuration ---
const downloadFolder = path.resolve(__dirname, 'downloads');

// UPDATE THIS PATH: Point this to your actual local GitHub repository folder
const repoFolder = 'D:\\Dev\\AutoSPOJ'; 

// The file will be saved directly into that repo folder
const jsonOutputFilePath = path.join(repoFolder, 'Data.json');

const selectors = {
    loginLink: '#header > div.name.pull-right > ul > li:nth-child(2) > a',
    usernameInput: '#inputUsername',
    passwordInput: '#inputPassword',
    loginButton: '#content > div > div > form > div.form-group.text-center > button',
    problemTable: ".problems"
};

const credentials = {
    username: 'ngoc_ha',
    password: 'P@sshaschanged12#$'
};

const urls = {
    status: 'https://www.spoj.com/EIUPROGR/status/',
    ranks: 'https://www.spoj.com/EIUPROGR/ranks/',
    download: 'https://www.spoj.com/EIUPROGR/problems/EIUPROGR/0.in'
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- C# Logic Ported to JavaScript ---
class SpojDataTokenizer {
    constructor(text) {
        this.lines = text.split('\n');
        this.index = 0;
    }
    getNext() {
        if (this.index >= this.lines.length) return "";
        return this.lines[this.index++].replace("\r", "");
    }
    getInt() { return parseInt(this.getNext(), 10); }
    getFloat() { return parseFloat(this.getNext()); }
    getUnixTime() {
        const unixTimestamp = this.getInt();
        if (isNaN(unixTimestamp)) return null;
        const date = new Date(unixTimestamp * 1000);
        return date.toISOString();
    }
    skip(n) { this.index += n; }
}

function parseContest(tokenizer) {
    const nLines = tokenizer.getInt();
    const contest = {
        Start: tokenizer.getUnixTime(),
        End: tokenizer.getUnixTime(),
        Name: null,
        ProblemsInfo: {},
        Users: {}
    };
    tokenizer.skip(1);
    contest.Name = tokenizer.getNext();
    tokenizer.skip(nLines - 4);
    return contest;
}

function parseProblems(tokenizer) {
    const nProblems = tokenizer.getInt();
    const nLines = tokenizer.getInt();
    const problems = {};
    for (let i = 0; i < nProblems; i++) {
        const problem = {
            Id: tokenizer.getInt(),
            TimeLimit: tokenizer.getFloat(),
            Code: tokenizer.getNext(),
            Name: tokenizer.getNext(),
            Type: tokenizer.getInt(),
            ProblemSet: tokenizer.getNext()
        };
        tokenizer.skip(nLines - 6);
        problems[problem.Id] = problem;
    }
    return problems;
}

function parseUsers(tokenizer) {
    const nUsers = tokenizer.getInt();
    const nLines = tokenizer.getInt();
    const users = {};
    for (let i = 0; i < nUsers; i++) {
        const user = {
            UserId: tokenizer.getInt(),
            Username: tokenizer.getNext(),
            DisplayName: tokenizer.getNext(),
            Email: tokenizer.getNext(),
            Problems: {}
        };
        tokenizer.skip(nLines - 4);
        users[user.UserId] = user;
    }
    return users;
}

function parseUserSubmissions(tokenizer, users, problemsInfo) {
    const nSeries = tokenizer.getInt();
    const nLine = tokenizer.getInt();
    tokenizer.skip(1);
    const nSubmissions = tokenizer.getInt();
    for (let i = 0; i < nSubmissions; i++) {
        const userId = tokenizer.getInt();
        const problemId = tokenizer.getInt();
        const time = tokenizer.getUnixTime();
        const status = tokenizer.getInt();
        const language = tokenizer.getInt();
        const score = tokenizer.getFloat();
        const runTime = tokenizer.getFloat();
        tokenizer.skip(1);
        const id = tokenizer.getInt();

        let languageText = "";
        switch (language) {
            case 10: languageText = "Java"; break;
            case 27: languageText = "C#"; break;
            case 32: languageText = "JS2"; break;
        }
        tokenizer.skip(nLine - 9);

        if (!problemsInfo[problemId]) continue;

        const problemInfo = problemsInfo[problemId];
        const submission = {
            Id: id,
            Time: time,
            Score: status === 15 && problemInfo.Type === 2 ? score : (status === 15 && problemInfo.Type === 0 ? 100 : 0),
            RunTime: runTime,
            Language: languageText
        };

        const user = users[userId];
        if (user) {
            let problem = user.Problems[problemId];
            if (!problem) {
                problem = { Id: problemId, Code: problemInfo.Code, Submissions: [] };
                user.Problems[problemId] = problem;
            }
            problem.Submissions.push(submission);
        }
    }
}

function getCsharpFormattedDate() {
    const now = new Date();
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    const ms = now.getMilliseconds().toString().padStart(3, '0');
    const ticks = ms + "0000";
    const offsetMinutes = now.getTimezoneOffset();
    const offsetHours = Math.abs(Math.floor(offsetMinutes / 60));
    const offsetMins = Math.abs(offsetMinutes % 60);
    const sign = offsetMinutes > 0 ? '-' : '+'; 
    const offsetString = `${sign}${offsetHours.toString().padStart(2, '0')}:${offsetMins.toString().padStart(2, '0')}`;
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ticks}${offsetString}`;
}

// ---------------------
// CORE LOGIC
// ---------------------

/**
 * Handles pushing to GitHub. 
 * This is synchronous; it waits for the upload to finish before continuing.
 */
function pushToGit() {
    try {
        console.log('--- Starting Git Sync ---');
        
        // 1. Add the file (LFS handles it if .gitattributes is set up)
        console.log('Git Add...');
        execSync('git add Data.json', { cwd: repoFolder });

        // 2. Commit
        console.log('Git Commit...');
        // We use a try-catch on commit because if the file hasn't changed, 
        // git commit returns an error code (1), which is fine.
        try {
            // execSync(`git commit -m "Auto-update: ${new Date().toISOString()}"`, { cwd: repoFolder });
            execSync('git commit --amend --no-edit', { cwd: repoFolder });
        } catch (e) {
            console.log('Nothing to commit (file likely unchanged).');
        }

        // 3. Push
        console.log('Git Push...');
        // execSync('git push origin main', { cwd: repoFolder });
        execSync('git push --force', { cwd: repoFolder });
        
        console.log('--- Git Sync Complete ---');
    } catch (error) {
        console.error('Git Push Failed!');
        throw error; // Throwing error here ensures the main loop retries the whole process
    }
}

async function attemptCrawl() {
    let browser;
    try {
        console.log(`[Attempt] Starting crawl process...`);
        fs.mkdirSync(downloadFolder, { recursive: true });

        const { browser: connectedBrowser, page } = await connect({
            headless: false,
            turnstile: true,
        });
        browser = connectedBrowser;

        await page.setViewport({ width: 1366, height: 768 });

        // 1. Navigation
        console.log(`Navigating to ${urls.status}...`);
        await page.goto(urls.status, { waitUntil: 'networkidle2' });
        await sleep(20000); 

        // 2. Login
        console.log('Logging in...');
        await page.click(selectors.loginLink);
        await sleep(1000);
        await page.waitForSelector(selectors.loginButton, { visible: true });
        await page.type(selectors.usernameInput, credentials.username);
        await page.type(selectors.passwordInput, credentials.password);
        await sleep(1000);
        await page.click(selectors.loginButton);
        await sleep(2000);

        // 3. Ranks
        console.log(`Navigating to ${urls.ranks}...`);
        await page.goto(urls.ranks, { waitUntil: 'networkidle2' });
        await sleep(1000);

        // 4. Download
        console.log(`Downloading data from ${urls.download}...`);
        await page.goto(urls.download);
        await sleep(30000);

        const textContent = await page.evaluate(() => document.body.innerText);

        if (!textContent || textContent.trim().length === 0) {
            throw new Error('Downloaded content was empty!');
        }

        const downloadFilePath = path.join(downloadFolder, '0.in');
        fs.writeFileSync(downloadFilePath, textContent, 'utf-8');
        
        // 5. Parse
        console.log('Parsing content...');
        const tokenizer = new SpojDataTokenizer(textContent);
        const contest = parseContest(tokenizer);
        contest.ProblemsInfo = parseProblems(tokenizer);
        contest.Users = parseUsers(tokenizer);
        parseUserSubmissions(tokenizer, contest.Users, contest.ProblemsInfo);
        contest.LastUpdated = getCsharpFormattedDate();

        // 6. Save to Git Repo Folder
        console.log(`Saving Data.json to repo: ${repoFolder}`);
        // Ensure repo folder exists (it should, if cloned)
        if (!fs.existsSync(repoFolder)) {
            throw new Error(`Repo folder not found at: ${repoFolder}. Check your path.`);
        }
        
        fs.writeFileSync(jsonOutputFilePath, JSON.stringify(contest, null, 2), 'utf-8');
        console.log(`[Success] Data saved locally.`);

        // 7. Push to GitHub
        // If this fails, the catch block below triggers, and we retry in 5 mins
        pushToGit();

    } catch (error) {
        console.error('[Error] An error occurred during this attempt:', error);
        throw error; 
    } finally {
        if (browser) {
            console.log('Closing browser for this attempt...');
            await browser.close();
        }
    }
}

// ---------------------
// MAIN RETRY LOOP
// ---------------------

async function main() {
    while (true) {
        try {
            await attemptCrawl();
            console.log('Job completed successfully. Exiting.');
            break; 
        } catch (error) {
            console.log('------------------------------------------------');
            console.log('Process failed. Retrying in 5 minutes...');
            console.log('------------------------------------------------');
            await sleep(5 * 60 * 1000);
        }
    }
}

main();