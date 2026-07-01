async function sendEmail({ to, subject, html, text, from: requestedFrom, attachments = [] }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = requestedFrom || process.env.RESEND_FROM || "ZMH USA Corp <verify@zmhusacorp.com>";

  if (!apiKey) {
    console.log("[email skipped]", { from, to, subject, text, attachments: attachments.map((item) => item.filename) });
    return { skipped: true };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html, text, attachments }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || "Resend email failed");
  }
  return data;
}

module.exports = { sendEmail };
