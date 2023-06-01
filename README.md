# Shekel Streamer

Shekel Streamer, powered by the [Israeli-bank-scrapers library](https://github.com/eshaham/israeli-bank-scrapers), is your personal finance bot. It scrapes transaction data, stores it in MongoDB, translates details with the OpenAI API, and sends updates to your Telegram channel(s). Multiple user setup, scheduled launch, detailed logging, and Docker deployment are available, along with robust error handling for reliability. A smart and dependable tool for your financial needs.

![Screenshot](screenshots/shekel-streamer.png?raw=true "Shekel Streamer")

Logs example:

![Logs](screenshots/logs.png?raw=true "Logs")

## Features

- Automated financial transactions scraping from specified providers.
- Storing transactions in a MongoDB database.
- Sending transaction notifications to specified Telegram channels.
- Customizable schedule for getting new transactions (by cron).
- Support for multiple users and separate credentials and Telegram channels for each financial provider.
- Translating transactions descriptions using the OpenAI API, catering to the Israeli context and supporting custom phrase recognition.
- Deployable using Docker with docker-compose and a published docker image.
- Detailed logging for monitoring and debugging purposes.
- Enhanced error handling to ensure service stability.
- Can be run on GitHub without the need for installing and supporting your own server.

## How to Run

You can run Shekel Streamer using different methods: yarn, Docker Compose, using a published Docker image, or directly on GitHub without the need for your own server.

### Running the App on GitHub

Shekel Streamer can be run directly on GitHub via GitHub Actions without the need for your own server. This requires some additional setup steps, which are detailed in the [GitHub Execution Guide](./docs/github_execution_guide.md).

Once you've completed the setup steps in that guide, the application will run automatically according to the schedule you set. This makes it easy to keep your financial transactions up-to-date without needing to manually run the application each time.

---

For all other methods, follow the steps below.

### Preparation

1. Clone the repository to your local machine by running `git clone https://github.com/uzser/shekel-streamer`.
2. Navigate into the cloned repository by running `cd shekel-streamer`.
3. Create a copy of the provided `.env.example` file and rename it to `.env`.
4. Fill in the necessary values in your `.env` file. See the [Configuration](#configuration) section for more details.

### Running the App using yarn

Firstly, ensure that yarn is installed on your machine. If you do not have yarn installed, you can install it using the  command `npm install -g yarn`. With yarn installed, follow these steps to run the app:

1. Install the necessary dependencies by running `yarn`.
2. Start the application by running `yarn start`.

Logs will be displayed in the console as well as stored in log files for further investigation if required.

### Running the App using Docker Compose

Build and run the application by executing in the project's root directory:

```bash
docker-compose up -d --build
```

To access the logs, use the command `docker-compose logs -f`.

### Running the App with Local MongoDB Instance using Docker Compose

You can run the project with its own MongoDB instance and [Mongo Express](https://github.com/mongo-express/mongo-express) for database management using the docker-compose.mongo.yml file.

Run the following command in the project's root directory:

```bash
docker-compose -f docker-compose.mongo.yml up -d --build
```

This configuration automatically sets the MongoDB connection string and credentials. You can access the Mongo Express interface at `http://localhost:8099` using `admin:ShEkElStReAmEr` as the login and the password (or the values you set in the docker-compose.mongo.yml file).

### Running the App using a Published Docker Image

You can run the application directly using a published Docker image. This is particularly useful in Kubernetes-based cloud environments or when you prefer not to clone the entire repository.

Pull and run the published Docker image using the command:

```bash
docker run --env-file .env -d --name shekel-streamer --pull=always uzser/shekel-streamer:latest
```

Alternatively, if you prefer not to use the `.env` file, you can pass all necessary environment variables directly to the `docker run` command:

```bash
docker run -d \
-e "VARIABLE1=value1" \
-e "VARIABLE2=value2"  \
--name shekel-streamer \
--pull=always \
uzser/shekel-streamer:latest
```

Replace `VARIABLE1=value1` and `VARIABLE2=value2` with the environment variables from the `.env.example` file, filled with the necessary values.

To update to a newer version, stop and remove the old container before running the new one:

```bash
docker stop shekel-streamer && docker rm shekel-streamer
```

All necessary environment variables are described in the [Configuration](#configuration) section.

### Running for one-time sync

If you need to scrape transactions only once, set the following in your `.env` file:

```plaintext
SYNC_ON_SCHEDULE=false
SYNC_ON_STARTUP=true
```

---
After following the steps corresponding to your chosen method, the application will start scraping transactions based on your settings.

## Configuration

Parameters can be placed in the `.env` file (using the provided `.env.example` file as a template) or passed as environment variables. Below is a list of the key parameters along with their descriptions. Required parameters are marked in bold.

| Parameter | Description | Example |
| --- | --- | --- |
| **MONGO_CONNECTION_STRING** | Note: MongoDB Atlas provides [a free tier](https://www.mongodb.com/pricing) for up to 5 GB of storage | `mongodb://localhost:27017` |
| DEFAULT_TIMEZONE | Timezone for the schedule, logging, and transactions timestamps | `Asia/Jerusalem` |
| TELEGRAM_BOT_TOKEN | Telegram bot token for sending notifications. <br/> If not set, the transactions will be just saved to the database without sending notifications. <br/> To get the token, talk to @BotFather on Telegram. | `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11` |
| SYNC_SCHEDULE | Cron schedule for getting new transactions, [see for help](https://crontab.guru/ ). <br/> Default: every day at 8:00 AM. | `0 8 * * *` |
| SYNC_DAYS_COUNT | Number of days to scrape transactions for. <br/> Most financial services provide transactions from up to one year, check the [documentation for the specific company](https://github.com/eshaham/israeli-bank-scrapers/blob/master/README.md#specific-definitions-per-scraper). | `7` |
| SYNC_ON_STARTUP | If true, transactions are scraped on service startup. <br/> For one-time scraping, set SYNC_ON_SCHEDULE to false and SYNC_ON_STARTUP to true. | `true` |
| SYNC_ON_SCHEDULE | If true, transactions are scraped on schedule. <br/> If SYNC_ON_SCHEDULE is set to false and SYNC_ON_STARTUP is set to false, the transactions will not be scraped at all. | `true` |
| **USERS** | Comma-separated list of users to scrape. It should match the prefix of the environment variables below. | `USER1,USER2,JOHN,MARY` |
| USERX_TELEGRAM_CHANNEL_ID | Telegram channel ID for user X. <br/> To get the channel ID, add the bot to the channel, visit `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates`, send a message to the channel mentioning the bot like `/start@YourBot`, update the page and look for the `chat` object. | `-1001234567890` |
| USERX_COMPANY_Y_TELEGRAM_CHANNEL_ID | Telegram channel for posting notifications from a particular provider, instead of using the common channel for the user | `-1001234567891` |
| **USERX_COMPANY_Y_CREDENTIALS** | User X's credentials for company Y. <br/> Any combination of the providers from the [documentation of the israeli-bank-scrapers](https://github.com/eshaham/israeli-bank-scrapers/blob/master/README.md#specific-definitions-per-scraper). <br/>  Company names should follow the names in this [list](https://github.com/eshaham/israeli-bank-scrapers/blob/2f9d73638b641c2c770f104a7887f7db12800cee/src/definitions.ts#L5) but in uppercase | JOHN_HAPOALIM_USER_CODE=`***` <br/> JOHN_HAPOALIM_PASSWORD=`***` |
| OPENAI_API_KEY | OpenAI API key for translating transactions' descriptions. <br/> For using the OpenAI API, you need to create an account and [get an API key](https://platform.openai.com/account/api-keys). | `sk-key1234` |
| GPT_MODEL_FAST | GPT model to use for translation | `gpt-3.5-turbo` |
| GPT_TRANSLATION_PROMPT | Transltion request to GPT, should contain the placeholder: `<text_to_replace>`. See [About translation using the OpenAI API](#about-translation-using-the-openai-api) for more details. | `Your translation prompt` |

### Adding a New User

Here's how you can add a new user for transaction scraping:

1. Update the `USERS` field in the `.env` file with the new user's identifier. If you're adding a user named `USERNAME`, the `USERS` field should be updated to include `USERNAME`, e.g. `USERS=USER1,USERNAME`.
2. Set the Telegram channel ID for the new user by creating a new environment variable named `USERNAME_TELEGRAM_CHANNEL_ID`. This is the channel where notifications for the user's transactions will be sent. If you want to use a specific channel for notifications from a particular provider, you can set `USERNAME_COMPANY_TELEGRAM_CHANNEL_ID`.
3. Add the new user's credentials for each financial provider from which you want to scrape transactions. You need to create new environment variables for each credential, following the pattern `USERNAME_COMPANY_CREDENTIALS`. Replace `COMPANY` with the financial provider's name and `CREDENTIALS` with the specific credential name. For example:

    ```plaintext
    # Hapoalim credentials for USERNAME
    USERNAME_HAPOALIM_USER_CODE=***
    USERNAME_HAPOALIM_PASSWORD=***

    # Isracard credentials for USERNAME
    USERNAME_ISRACARD_ID=***
    USERNAME_ISRACARD_CARD6DIGITS=***
    USERNAME_ISRACARD_PASSWORD=***
    USERNAME_ISRACARD_TELEGRAM_CHANNEL_ID=-1001234567891

    ```

4. For each provider, the user's credentials should match the specifications listed in the [israeli-bank-scrapers documentation](https://github.com/eshaham/israeli-bank-scrapers/blob/master/README.md#specific-definitions-per-scraper).

After these steps, the new user will be configured for transaction scraping, and notifications will be sent to the specified Telegram channel(s). In all the examples above, replace `USERNAME` with the actual username you're configuring.

## About translation using the OpenAI API

The translation process is designed taking into account the Israeli context and allows you to recognize custom phrases. For example, the translation process could use the following prompt given in the file `.env.example`:

```plaintext
You are a translation service.
Use the list of correct translations of some sentences when translating (format: "original text|translation"):

פועלים-|Hapoalim
אושר עד|Osher Ad

Please provide the translations for each line of text, plain list without original text.
Here is an example request:
מסטרקרד
מסטרקרד

And the corresponding response:
Mastercard
Mastercard

Now, translate into English every following line of text, specifically in the Israeli context:
מסטרקרד
<text_to_replace>
Respond in a one-column TSV format.
```

In this example, `<text_to_replace>` is a placeholder where the original descriptions of transactions will be placed for translation. You can add a list of custom phrases and their correct translations to the prompt. The system will then recognize these phrases and translate them accordingly.

Translation requests are performed in batches to efficiently utilize the OpenAI API. To avoid exceeding the token limit, a configuration for chunk size (number of translations per request) is provided.

Additionally, to optimize the translation process and avoid redundant API calls, translations are cached in the database.

## Contributing

Please feel free to submit issues or pull requests for any improvements or bug fixes. Your contributions are always welcome!

## License

This project is licensed under the MIT License.
