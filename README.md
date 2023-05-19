# **ShekelStreamer**

This project uses a series of configurable environment variables to automatically scrape financial transactions, store them in a MongoDB database, translate their descriptions using the OpenAI API, and finally send them to specified Telegram channels. This system uses a cron job to regularly pull new transactions, which are processed and stored.

## **Features**

- Automated financial transactions scraping from specified providers
- Storing transactions in a MongoDB database
- Sending transaction notifications to specified Telegram channels
- Customizable schedule for getting new transactions
- Support for multiple users and separate credentials for each financial provider
- Translating transactions descriptions using the OpenAI API, catering to the Israeli context and supporting custom phrase recognition (optional)

## **Parameters**

| Parameter | Description | Example |
| --- | --- | --- |
| MONGO_CONNECTION_STRING | MongoDB connection string | mongodb+srv://user:password@cluster0.mongodb.net/myFirstDatabase?retryWrites=true&w=majority |
| TELEGRAM_BOT_TOKEN | Telegram bot token for sending notifications | 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11 |
| TRANSACTION_SYNC_SCHEDULE | Cron schedule for getting new transactions | 0 8 * * * |
| USERS | Comma-separated list of users to scrape | USER1,USER2,JOHN,MARY |
| USERX_TELEGRAM_CHANNEL_ID | Telegram channel ID for user X | -1001234567890 |
| USERX_COMPANY_Y_CREDENTIALS | User X's credentials for company Y | JOHN_HAPOALIM_USER_CODE |
| OPENAI_API_KEY | OpenAI API key for translating transactions' descriptions | sk-key1234 |
| GPT_MODEL_FAST | GPT model to use for translation | gpt-3.5-turbo |
| GPT_TRANSLATION_PROMPT | Translation request to GPT | Your translation prompt |

For USERX_COMPANY_Y_CREDENTIALS, replace USERX with the user's name and COMPANY_Y with the company name. The company should match one of the providers listed [here](https://github.com/eshaham/israeli-bank-scrapers/blob/6b961fd7318cc522ac12de83498c1e6c2316ac68/src/definitions.ts#L5). You can find descriptions and formats for the required credentials in the [documentation](https://github.com/eshaham/israeli-bank-scrapers/blob/master/README.md#specific-definitions-per-scraper).

## **Usage and Configuration**

1. Copy the provided `.env.example` file to a new file named `.env`.
2. Fill in the required values in the `.env` file.
3. Run the application with the configured environment variables.
4. The application will start automatically scraping transactions according to the specified cron schedule.

Please note that if the TELEGRAM_BOT_TOKEN is not set, transactions will only be saved to the database without sending any notifications. If the OpenAI API key is not set, transactions will be saved and sent without translated descriptions.

If you want to configure notifications for a new user, you must set the USERX_TELEGRAM_CHANNEL_ID and USERX_COMPANY_Y_CREDENTIALS parameters, where USERX is the user's name and COMPANY_Y is the company name. Each user can have separate credentials for each financial provider.

For further information, refer to the `.env.example` file provided in the repository.

### About translation using the OpenAI API

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

## **Contributing**

Please feel free to submit issues or pull requests for any improvements or bug fixes. Your contributions are always welcome!

## **License**

This project is licensed under the MIT License.
