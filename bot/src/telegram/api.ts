/**
 * The few Telegram Bot API calls the bridge needs, over plain fetch.
 * https://core.telegram.org/bots/api
 */

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string; title?: string };
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  reply_to_message?: TgMessage;
  edit_date?: number;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgReactionType {
  type: string;
  emoji?: string;
}

export interface TgMessageReaction {
  chat: { id: number };
  message_id: number;
  user?: TgUser;
  old_reaction: TgReactionType[];
  new_reaction: TgReactionType[];
}

export interface TgUpdate {
  update_id: number;
  message_reaction?: TgMessageReaction;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

/**
 * "auto": Telegram previews the first link in the text (a TradingView chart,
 * say). A URL: that page or image is previewed as a small thumbnail.
 * Anything else: no preview.
 */
export function previewOptions(preview?: string | null) {
  if (preview === "auto") return undefined;
  return preview ? { url: preview, prefer_small_media: true, show_above_text: false } : { is_disabled: true };
}

export class TelegramError extends Error {
  constructor(readonly method: string, readonly code: number, readonly description: string, readonly retryAfter?: number) {
    super(`telegram ${method} ${code}: ${description}`);
  }
}

export class TelegramApi {
  constructor(private token: string, private fetchImpl: typeof fetch = fetch) {}

  async call<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal,
    });
    const body = (await res.json().catch(() => ({ ok: false, error_code: res.status, description: res.statusText }))) as {
      ok: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!body.ok) throw new TelegramError(method, body.error_code ?? res.status, body.description ?? "unknown error", body.parameters?.retry_after);
    return body.result as T;
  }

  getMe() {
    return this.call<TgUser>("getMe");
  }

  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal) {
    return this.call<TgUpdate[]>("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "edited_message", "callback_query", "message_reaction"] }, signal);
  }

  sendMessage(chatId: number, html: string, opts: { replyTo?: number; buttons?: InlineButton[][]; silent?: boolean; preview?: string | null } = {}) {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: previewOptions(opts.preview),
      disable_notification: opts.silent,
      reply_parameters: opts.replyTo ? { message_id: opts.replyTo, allow_sending_without_reply: true } : undefined,
      reply_markup: opts.buttons ? { inline_keyboard: opts.buttons } : undefined,
    });
  }

  /** `photo` is a public URL; Telegram fetches it itself. */
  sendPhoto(chatId: number, photo: string, captionHtml: string, opts: { replyTo?: number } = {}) {
    return this.call<TgMessage>("sendPhoto", {
      chat_id: chatId,
      photo,
      caption: captionHtml,
      parse_mode: "HTML",
      reply_parameters: opts.replyTo ? { message_id: opts.replyTo, allow_sending_without_reply: true } : undefined,
    });
  }

  editMessageText(chatId: number, messageId: number, html: string, buttons?: InlineButton[][], preview?: string | null) {
    return this.call<TgMessage | true>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: previewOptions(preview),
      reply_markup: buttons ? { inline_keyboard: buttons } : undefined,
    });
  }

  editMessageCaption(chatId: number, messageId: number, html: string) {
    return this.call<TgMessage | true>("editMessageCaption", { chat_id: chatId, message_id: messageId, caption: html, parse_mode: "HTML" });
  }

  deleteMessage(chatId: number, messageId: number) {
    return this.call<true>("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  /** The user's current Telegram profile picture, or null when they have none or hide it. */
  async profilePhoto(userId: number): Promise<Buffer | null> {
    const res = await this.call<{ photos: TgPhotoSize[][] }>("getUserProfilePhotos", { user_id: userId, limit: 1 });
    const sizes = res.photos[0];
    if (!sizes?.length) return null;
    const pick = sizes.find((p) => p.width >= 256) ?? sizes[sizes.length - 1];
    return this.download(pick.file_id);
  }

  getChatAdministrators(chatId: number) {
    return this.call<{ user: TgUser; status: string }[]>("getChatAdministrators", { chat_id: chatId });
  }

  /** Bots may set one reaction per message; null clears it. */
  setMessageReaction(chatId: number, messageId: number, emoji: string | null) {
    return this.call<true>("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: emoji ? [{ type: "emoji", emoji }] : [] });
  }

  answerCallbackQuery(id: string, text?: string) {
    return this.call<true>("answerCallbackQuery", { callback_query_id: id, text });
  }

  /** Downloads a file the bot can see. The URL carries the token, so it never leaves this process. */
  async download(fileId: string): Promise<Buffer> {
    const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("telegram file has no path (over 20 MB?)");
    const res = await this.fetchImpl(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`telegram file download ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
