const EMAIL_ADDRESSES = {
  notifications: "noreply@zmhusacorp.com",
  accounts: "accounts@zmhusacorp.com",
  billing: "billing@zmhusacorp.com",
  support: "support@zmhusacorp.com",
  sales: "sales@zmhusacorp.com",
};

const EMAIL_SENDERS = {
  notifications: `ZMH USA Notifications <${EMAIL_ADDRESSES.notifications}>`,
  accounts: `ZMH USA Accounts <${EMAIL_ADDRESSES.accounts}>`,
  billing: `ZMH USA Billing <${EMAIL_ADDRESSES.billing}>`,
  support: `ZMH USA Support <${EMAIL_ADDRESSES.support}>`,
  sales: `ZMH USA Sales <${EMAIL_ADDRESSES.sales}>`,
};

module.exports = { EMAIL_ADDRESSES, EMAIL_SENDERS };
