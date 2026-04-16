const fs = require('fs').promises;

async function countUsers() {
    try {
        // 1. Read the file content
        const data = await fs.readFile('Data.json', 'utf8');

        // 2. Parse the string into a JavaScript object
        const obj = JSON.parse(data);

        // 3. Get the number of keys in the Users object
        const count = Object.keys(obj.Users).length;

        console.log(`Total number of users: ${count}`);
        let totalSubmissions = 0;

        // 1. Loop through each User
        for (const userId in obj.Users) {
            const user = obj.Users[userId];

            // 2. Loop through each Problem for that user
            if (user.Problems) {
                for (const problemId in user.Problems) {
                    const problem = user.Problems[problemId];

                    // 3. Add the length of the Submissions array (with safety check)
                    totalSubmissions += problem.Submissions?.length || 0;
                }
            }
        }

        console.log(`Total Submissions across all users and problems: ${totalSubmissions}`);
    } catch (err) {
        console.error("Error reading or parsing the file:", err);
    }
}

countUsers();