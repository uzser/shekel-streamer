/**
 * Function to standardize currency symbols to ISO currency codes.
 * @param {string} currency Currency symbol (e.g., ₪, $, €)
 * @returns {string} ISO currency code (e.g., ILS, USD, EUR)
 */
export function currencyToIsoCode(currency) {
  return (currency || '').replace('₪', 'ILS').replace('$', 'USD').replace('€', 'EUR');
}

/**
 * The document that the app stores and posts for one scraped transaction.
 * chargedAmount is in chargedCurrency: card purchases abroad are charged in USD or EUR, not ILS.
 */
export function toStoredTransaction(account, txn, { companyId, user, chatId }) {
  return {
    accountNumber: account.accountNumber,
    date: new Date(txn.date),
    description: txn.description,
    translatedDescription: null, // will be filled later
    memo: txn.memo, // can be null
    originalAmount: txn.originalAmount,
    originalCurrency: currencyToIsoCode(txn.originalCurrency), // can be null, possible wrong value: ILS instead of USD
    chargedAmount: txn.chargedAmount, // possible the same as originalAmount, even if originalCurrency is USD/EUR
    chargedCurrency: currencyToIsoCode(txn.chargedCurrency) || null, // cards: completed rows only
    type: txn.type, // normal | installments
    status: txn.status, // completed | pending
    identifier: txn.identifier, // can be null
    processedDate: new Date(txn.processedDate),
    installments: txn.installments, // can be null
    category: txn.category, // can be null
    companyId: companyId,
    userCode: user,
    chatId: chatId
  };
}
