import axios from 'axios';
import { TELEGRAM_BASE, CHAT_ID } from '../config/env.js';

async function callTelegramApi(method, payload) {
  const url = `${TELEGRAM_BASE}/${method}`;
  try {
    const { data } = await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' },
    });

    if (!data.ok) {
      console.error(`[Telegram] ${method} rejected by API:`, data.description || data);
      throw new Error(`Telegram API error on ${method}: ${data.description || 'unknown error'}`);
    }

    return data.result;
  } catch (err) {
    if (err.response?.data) {
      console.error(`[Telegram] ${method} failed (HTTP ${err.response.status}):`, err.response.data.description || err.response.data);
    } else if (!err.message?.startsWith('Telegram API error')) {
      console.error(`[Telegram] ${method} request failed:`, err.message);
    }
    throw err;
  }
}

export function tgSendRichMessage(chatId, blocks) {
  return callTelegramApi('sendRichMessage', { 
    chat_id: chatId, 
    rich_message: { blocks: blocks } 
  });
}

/** Sends a text-only message to a chat. */
export function tgSendMessage(chatId, text, options = {}) {
  return callTelegramApi('sendMessage', { chat_id: chatId, text, ...options });
}

/** Fetches incoming updates via long polling. */
export async function getUpdates(offset = 0, timeout = 30) {
  return callTelegramApi('getUpdates', { offset, timeout });
}


export async function sendRichMoviePost(movie, blocks) {
  try {
    await tgSendRichMessage(CHAT_ID, blocks);
    console.log(`[Telegram] Sent rich message post for "${movie.title}".`);
  } catch (err) {
    console.error(`[Telegram] Failed to send rich message for "${movie.title}":`, err.message);
    throw err;
  }
}