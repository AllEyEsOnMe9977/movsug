import axios from 'axios';
import { OPENAI_API_KEY } from '../config/env.js';

function buildTranslationSystemPrompt(movieMeta) {
  const { title = '', genres = [], release_date = '' } = movieMeta;
  const genreNames = genres.map((g) => g.name.toLowerCase());
  const year = (release_date || '').split('-')[0] || '';

  const isSeriousOrDrama = genreNames.some((g) => ['drama', 'war', 'history', 'biography'].includes(g)) &&
                           !genreNames.some((g) => ['comedy', 'animation', 'family'].includes(g));
  const isPoetic = genreNames.some((g) => ['romance', 'music', 'fantasy'].includes(g));
  const isActionPacked = genreNames.some((g) => ['action', 'thriller', 'crime'].includes(g));
  const isLightOrFun = genreNames.some((g) => ['comedy', 'animation', 'family', 'adventure'].includes(g));
  const isHorrorOrDark = genreNames.some((g) => ['horror', 'mystery'].includes(g));

  let toneInstruction = '';
  if (isSeriousOrDrama) toneInstruction = 'لحن نوشتار باید جدی، احساسی و عمیق باشه. از ایموجی‌های کمی استفاده کن یا اصلاً نکن — فقط در مواردی که واقعاً تأثیر داره. جملات باید سنگین و تأثیرگذار باشن.';
  else if (isHorrorOrDark) toneInstruction = 'لحن باید تاریک، مرموز و نفس‌گیر باشه. از ایموجی‌های تاریک مثل 🖤🕯️🌑 استفاده کن. جملات کوتاه، ضربه‌ای و ترسناک.';
  else if (isPoetic) toneInstruction = 'لحن باید شاعرانه، احساساتی و رمانتیک باشه. از ایموجی‌های ظریف مثل 🌹✨🎶 استفاده کن. جملات روان و ادبی.';
  else if (isActionPacked) toneInstruction = 'لحن باید پرانرژی، سریع و هیجان‌انگیز باشه. از ایموجی‌های پرهیجان مثل 💥🔥⚡ استفاده کن. جملات کوتاه و ضربه‌ای.';
  else if (isLightOrFun) toneInstruction = 'لحن باید شاد، سبک و سرگرم‌کننده باشه. ایموجی‌های بامزه و رنگارنگ زیاد استفاده کن 🎉😄🌈. جملات پرانرژی و دوست‌داشتنی.';
  else toneInstruction = 'لحن باید محاوره‌ای، جذاب و طبیعی باشه. ایموجی‌های متناسب به اندازه کافی استفاده کن.';

  console.log(`[OpenAI] Tone profile for "${title}": genres=[${genreNames.join(', ')}]`);

  return (
    `تو یه کپشن‌نویس حرفه‌ای برای کانال معرفی فیلم هستی.\n\n` +
    `اطلاعات فیلم:\n` +
    `- اسم: "${title}"\n` +
    `- سال: ${year || 'نامشخص'}\n` +
    `- ژانر: ${genreNames.join(', ') || 'نامشخص'}\n\n` +
    `وظیفه‌ات:\n` +
    `یه توضیح فارسی بنویس که:\n` +
    `1. خلاصه داستان (summary) که بهت داده میشه رو به فارسی بازنویسی کنه — نه ترجمه مستقیم، بلکه روان و جذاب.\n` +
    `2. اگه اطلاعاتت درباره این فیلم کافیه، میتونی یه جمله مکمل اضافه کنی که بینش عمیق‌تری بده — مثلاً موضوع اصلی، پیام فیلم، یا چیزی که فیلم رو خاص میکنه.\n` +
    `3. اگه اطلاعاتت کافی نیست یا مطمئن نیستی، همون خلاصه داده‌شده رو خوب بازنویسی کن — هیچ چیزی اضافه نکن که مطمئن نیستی.\n\n` +
    `قوانین سخت:\n` +
    `- هرگز اسپویل ندی یا پایان‌بندی رو لو نده.\n` +
    `- هرگز اطلاعاتی که در خلاصه نیست و مطمئن نیستی رو اختراع نکن.\n` +
    `- متن باید بین ۳ تا ۵ جمله باشه — نه کمتر، نه بیشتر.\n` +
    `- خروجی فقط متن فارسی باشه، بدون توضیح اضافه یا پیشگفتار.\n\n` +
    `راهنمای لحن برای این فیلم:\n${toneInstruction}`
  );
}

export async function translateToPersian(text, movieMeta = {}, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data } = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-5.4',
          messages: [
            { role: 'system', content: buildTranslationSystemPrompt(movieMeta) },
            { role: 'user', content: text },
          ],
          max_completion_tokens: 280,
          temperature: 1.0,
        },
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      console.log(`[OpenAI] Translation successful (attempt ${attempt}).`);
      return data.choices[0].message.content.trim();
    } catch (err) {
      const isRateLimit = err.response?.data?.error?.code === 'rate_limit_exceeded';
      if (isRateLimit && attempt < retries) {
        const wait = Math.pow(2, attempt) * 1000;
        console.warn(`[OpenAI] Rate limit hit. Retrying in ${wait / 1000}s...`);
        await new Promise((r) => setTimeout(r, wait));
      } else {
        console.error(`[OpenAI] Translation failed on attempt ${attempt}:`, err.response?.data ?? err.message);
      }
    }
  }

  console.warn('[OpenAI] All translation attempts failed. Using original text.');
  return text;
}