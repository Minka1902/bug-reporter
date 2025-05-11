# 🐞 Auto GitHub Error Reporter

A lightweight Node.js utility that detects application errors, searches for similar GitHub issues, and optionally creates a new issue — all automatically.

## 🚀 Features

- ✅ Detects runtime errors in your app
- 🔍 Searches your GitHub repo for similar issues
- 🤖 Auto-creates a new issue if none found (optional, with token)
- 🤫 Silent mode support for background reporting
- 🔧 Works with multiple GitHub repositories

## 📦 Installation

```bash
npm install your-error-reporter
```


## 🧑‍💻 Usage
```jsx
import { reportError } from "your-error-reporter";

try {
  // some faulty code
} catch (error) {
  reportError(error, {
    owner: "your-username-or-org",
    repo: "your-repo-name",
    token: process.env.GITHUB_TOKEN, // optional
    silent: false                    // optional
  });
}
```

## 🔐 Authentication (optional)
To automatically create GitHub issues, pass a GitHub personal access token via token.

Steps:

1. Go to GitHub Tokens.

2. Generate a token with the repo scope.

3. Store it safely in a .env file:
```bash
GITHUB_TOKEN=ghp_abcdef123456...
```
Then load it with:
```jsx
const dotenv = require("dotenv");
dotenv.config();
```

## Options
| Option       | Type      | Description                                                 |
| ------------ | --------- | ----------------------------------------------------------- |
| `owner`      | `string`  | GitHub username or org (default: set internally)            |
| `repo`       | `string`  | Repository name (default: set internally)                   |
| `token`      | `string`  | GitHub token for issue creation (optional)                  |
| `silent`     | `boolean` | Suppress logs except for critical errors                    |

📖 Example Output
```bash
[Info] A similar issue already exists:
> TypeError: Cannot read properties of undefined (reading 'x')

# or

⚠️ This issue hasn’t been reported yet.
🔗 You can report it here: https://github.com/your/repo/issues/new?title=Bug:...
```
Or, if a github token is provided:

```bash
🛠️ Creating new GitHub issue automatically...
✅ Issue created: https://github.com/your/repo/issues/123
```

## ⚠️ Notes
This package is designed to work asynchronously to avoid blocking your main app.

Consider adding a timeout or using silent: true in production environments.

Rate limiting applies if you create too many issues with a token.