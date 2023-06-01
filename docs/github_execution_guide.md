# GitHub Execution Guide or How to Run the App via GitHub Actions

## Prerequisites

1. GitHub Account: You will need a GitHub account to fork the repository and set up GitHub Actions. If you don't already have one, you can sign up at [https://github.com/join].
2. Telegram Account: A Telegram account is required to get notifications from the bot. You can download the Telegram app on your phone or use the web version at [https://web.telegram.org/].
3. OpenAI Account (Optional): You will need an OpenAI account to use the GPT-3 translation feature. You can sign up at [https://chat.openai.com/auth/login].

## Telegram Bot Creation

1. Open the Telegram app on your device and search for "@BotFather" in the search bar.
2. Start a chat with BotFather and type in the command "/newbot" to create a new bot.
3. Follow the prompts given by BotFather to name your bot and choose a username for it. The username must end in 'bot'.
4. Upon completion, BotFather will provide you with a token for your bot. Keep this token safe as it will be used to authorize your bot and send requests to the Telegram Bot API.

## Getting Chat ID

1. Add the bot you created to the channel you want it to interact with.
2. Visit the following URL in your web browser, replacing `<TELEGRAM_BOT_TOKEN>` with the bot token you received from BotFather: `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates`
3. Send a message to the channel where you added the bot. In the message, mention the bot using the format `/start@YourBot`
4. Refresh the page you opened in step 2. Look for the "chat" object in the returned JSON, the "id" field in this object is your chat ID.

## Create MongoDB

1. Go to MongoDB Atlas website ([https://www.mongodb.com](https://www.mongodb.com/)) and sign up or log in.
2. Click on “Build a Cluster”, then select the “Free” plan.
3. Choose AWS as your cloud provider.
4. Select a region. The EU or USA are recommended for better performance.
5. Go to the Network Access settings and add a new IP address. Enter "0.0.0.0/0" to allow connections from all IP addresses.
6. Create a new MongoDB user for your cluster following this guide: [MongoDB User Creation Guide](https://www.mongodb.com/docs/atlas/tutorial/create-mongodb-user-for-cluster/). Make sure to assign the "Read and write to any database" role to the user.
7. Once the user is created, get your MongoDB connection string by following the instructions on this page: [Connect to your Atlas Cluster](https://www.mongodb.com/docs/atlas/tutorial/connect-to-your-cluster/#connect-to-your-atlas-cluster). Choose "Node.js" as your driver.
8. The connection string will look something like this: `mongodb+srv://<username>:<password>@clustername.mongodb.net/test?retryWrites=true&w=majority&useNewUrlParser=true&useUnifiedTopology=true`. Replace `<username>` and `<password>` with the username and password you set while creating the MongoDB user.

## JSON Configuration

Here's an example of how to fill out the JSON configuration:

```json
[
  {
    "userName": "JohnDoe",
    "telegramChannelId": "-1000111",
    "companies": [
      {
        "companyName": "hapoalim",
        "userCode": "john123",
        "password": "password123"
      },
      {
        "companyName": "isracard",
        "telegramChannelId": "-100002222",
        "id": "123456789",
        "card6Digits": "123456",
        "password": "password123"
      }
    ]
  },
  {
    "userName": "JaneDoe",
    "telegramChannelId": "-100003333",
    "companies": [
      {
        "companyName": "isracard",
        "id": "987654321",
        "card6Digits": "654321",
        "password": "password456"
      }
    ]
  }
]
```

The JSON file consists of an array of user objects. Each user object represents a unique user and contains the following properties:

- `userName`: This is a string representing the username of the user.
- `telegramChannelId`: This is a string representing the Telegram Channel ID where the bot will send messages for this user.
- `companies`: This is an array of company objects related to the user.

Each company object represents a company related to the user and contains different properties depending on the company. Any combination of the providers and credentials field from [the list](https://github.com/eshaham/israeli-bank-scrapers/blob/master/README.md#specific-definitions-per-scraper).

- `companyName`: Company names should follow the names in [this list](https://github.com/eshaham/israeli-bank-scrapers/blob/2f9d73638b641c2c770f104a7887f7db12800cee/src/definitions.ts#L5).
- `telegramChannelId`: This is a string representing the Telegram Channel ID where the bot will send messages for this company. Note that this field is optional and will override the `telegramChannelId` of the user if specified.
- other fields: These fields are specific to each company and are used to authenticate the user. See [the list](https://github.com/eshaham/israeli-bank-scrapers/blob/master/README.md#specific-definitions-per-scraper).

The structure of this JSON configuration is flexible. You can add more users or companies as needed. Each user can have multiple companies, and each company can have different credentials.

To remove unnecessary elements, simply remove the corresponding user or company object from the JSON. Be careful when removing elements to maintain the correct JSON structure. Always check your JSON for errors after making changes. There are many free online tools available that can help you validate your JSON. According to personal observations, [this tool](https://jsonformatter.curiousconcept.com/) is recommended.

❗️ Keep your JSON configuration file safe or delete it after converting it to Base64. Anyone with access to your JSON configuration file can access your bank accounts.

## Convert JSON to Base64

To convert your JSON configuration to Base64, you can use the following commands:

### On Mac

1. Create Your JSON Configuration: First, you need to create your JSON configuration. Use any text editor (like TextEdit) and fill out the configuration as required. Save this file with a `.json` extension. For instance, you could name it `config.json`.
2. Open Terminal: You can open Terminal by pressing `Cmd + Space` to open Spotlight Search, typing "Terminal", and hitting Enter.
3. Navigate to Your JSON File's Directory: In the Terminal, navigate to the directory where you saved `config.json` using the `cd` command. For example, if you saved `config.json` on your desktop, you would type:

   ```bash
   cd "/Users/<YourUsername>/Desktop"
   ```

    Replace **`<YourUsername>`** with your actual username.

4. Convert JSON to Base64: Now that you're in the correct directory, you can convert `config.json` to a Base64 string. Run the following command:

    ```bash
    base64 -i config.json -o base64.txt
    ```

   This command will create a new file `base64.txt` containing the Base64 encoded JSON.

5. Copy the Output: To view and copy the Base64 string, open the `base64.txt` file with a text editor or use the `cat` command in Terminal:

    ```bash
    cat base64.txt
    ```

    Then, select and copy the entire output string. Make sure to copy the entire string without any trailing or leading white space.

6. Save Your Base64 String: Paste your Base64 string into a safe place. You'll need it in the next steps when you configure your GitHub repository secrets.

### On Windows

1. Create Your JSON Configuration: First, you need to create your JSON configuration. Use any text editor (such as Notepad) and fill out the configuration as required. Save this file with a `.json` extension. For instance, you could name it `config.json`.
2. Open PowerShell: Press the Windows key, type "PowerShell" into the search bar, and hit Enter. This opens the PowerShell console.
3. Navigate to Your JSON File's Directory: In the PowerShell console, navigate to the directory where you saved `config.json` using the `cd` command. For example, if you saved `config.json` on your desktop, you would type:

    ```powershell
    cd "C:\Users\<YourUsername>\Desktop"
    ```

    Replace `<YourUsername>` with your actual username.

4. Convert JSON to Base64: Now that you're in the correct directory, you can convert `config.json` to a Base64 string. Run the following command:

    ```powershell
    [Convert]::ToBase64String([IO.File]::ReadAllBytes('.\config.json'))
    ```

5. Copy the Output: The command will output a long string of characters. This is your Base64 encoded JSON. Right-click in the PowerShell window to copy this string. Make sure to copy the entire string without any trailing or leading white space.
6. Save Your Base64 String: Paste your Base64 string into a safe place. You'll need it in the next steps when you configure your GitHub repository secrets.

---

❗️ Again, remember that this Base64 string represents your sensitive JSON configuration. Treat it like a password and keep it secure or delete it after setting up your GitHub repository secrets. If anyone gains access to this string, they can decode it and view your original JSON configuration.

## GitHub Forking and Setting Up

1. If you haven't already, sign up for GitHub at [https://github.com/join].
2. Navigate to [this repository](https://github.com/uzser/shekel-streamer).
3. Click on the "Fork" button at the top right of the page.
4. Once the repository is forked to your account, click on the "Settings" tab.

## Set Secret Variables in GitHub

1. Go to your GitHub repository and click on the "Settings" tab.
2. Click on "Secrets and variables" in the left sidebar. Then click on "Actions".
3. Click on "New repository secret" to create each of the following secrets:
    - `USERS_JSON_BASE64`: Use the Base64 encoded JSON from the previous step.
      - Be sure to copy the entire string without any trailing or leading white space.
      - ❗️ Be aware that this string is sensitive and should be treated like a password. Keep it secure or delete it after setting up your GitHub repository secrets.
      - ❗️ Be aware that you create the SECRET, **not the VARIABLE**.
    - `MONGO_CONNECTION_STRING`: Use the MongoDB connection string obtained earlier.
    - `TELEGRAM_BOT_TOKEN`: Use the token from BotFather.
    - `OPENAI_API_KEY` (optional): If you want to use the translation feature, you'll need to get an API key from [your OpenAI account](https://platform.openai.com/account/api-keys).
    - `GPT_TRANSLATION_PROMPT` (optional): If you want to customize the translation prompt (add your name, for example), you can set this variable to the personalized prompt.

## Enabling/Disabling Scheduled Running

1. Go to your GitHub repository and click on the "Settings" tab.
2. Click on "Secrets and variables" in the left sidebar. Then click on "Actions".
3. Click on "Variables" tab.
4. Click on "New repository variable" to create the following variable:
   - `SCHEDULED_RUN_ENABLED`: Set this variable to 'true' to enable scheduled running. Set it to 'false' to disable scheduled running.

Default time for scheduled running is 5 AM UTC (8 AM Israeli Daylight Time). You can change it by editing [the workflow file](../.github/workflows/scheduled-app-run.yml):

1. In the workflow file, find the "`- cron:  '0 5 * * *'`" line and adjust it to your preferred schedule. The time should be in [cron format](https://crontab.guru/), and times are in UTC.
2. Save your changes and commit the workflow file.

Now you're all set! Your app should run on the schedule you set, and it will use the configuration and secrets you provided.

## Troubleshooting

If you're having trouble setting up the app, here are some things to check:

1. Make sure you've set all the required secrets in your GitHub repository.
2. Make sure you've set the `SCHEDULED_RUN_ENABLED` variable to 'true' if you want to enable scheduled running.

For debugging purposes, you can set the `LOG_LEVEL` variable to `debug` to get more detailed logs.
❗️ Be aware that the debug logs can contain sensitive information. For example, the translation feature will log the translated text, which can contain transactation descriptions. Make sure to delete the debug logs after you're done debugging.

If you're still having trouble, feel free to [open an issue](https://github.com/uzser/shekel-streamer/issues/new) and I'll try to help.

## About Security and Privacy

This app uses GitHub Actions to run the app on a schedule. GitHub Actions are secure and private by default. The app will run on GitHub's servers, and the only information that will be sent to GitHub is the output of the app. The app will not send any of your secrets or configuration to GitHub or any other third party service.  
All of your secrets and configuration are stored securely on GitHub and are not shared with anyone. The app will only use your secrets and configuration to run the app on a schedule and send you Telegram messages. The app will not share your secrets or configuration with anyone else.  
Note, that **the logs of the public repository are public**. This means that anyone can view the logs of the app. The logs **will not contain any of your secrets or configuration**, but they will contain the output of the app. All the sensitive information in the output of the app will be replaced with asterisks. For example, if the app sends a message with your Telegram bot token, the token will be replaced with asterisks in the logs. If you want to disable the logs, you can do so by adding the `LOG_LEVEL` variable to your GitHub repository secrets and setting it to `disabled`.  
Another option is to clone this repository and create your own private repository. Then you can set up your own GitHub Actions workflow to run the app on a schedule. This way, you can be sure that your logs are private and not shared with anyone.  
And of course, you can always run the app locally on your own computer. This way, you can be sure that your secrets and configuration are not shared with anyone.
