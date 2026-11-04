export class Telegram {
  constructor(private token: string, private fetcher: typeof fetch = ((i: any, o?: any) => fetch(i, o)) as typeof fetch) {}

  async call(method: string, payload: Record<string, unknown>): Promise<any> {
    const r = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`Telegram ${method} failed: ${r.status} ${j.description ?? ""}`);
    return j.result;
  }

  send(chatId: number, text: string, extra: Record<string, unknown> = {}) {
    // Plain text (no parse_mode) so user content can never break formatting.
    return this.call("sendMessage", { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true, ...extra });
  }

  answerCallback(id: string, text: string) {
    return this.call("answerCallbackQuery", { callback_query_id: id, text: text.slice(0, 190), show_alert: text.length > 60 });
  }

  editMarkup(chatId: number, messageId: number, markup: unknown) {
    return this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: markup });
  }
}

export function kb(rows: Array<Array<{ text: string; data: string }>>) {
  return { inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data.slice(0, 64) }))) };
}
