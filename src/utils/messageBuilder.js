import { TMDB_IMG_BASE } from '../config/env.js';

export function buildRichBlocks(movie, details, translatedOverview, omdb = {}) {
  const year = (movie.release_date || '').split('-')[0] || '—';
  const { imdbRating, imdbVotes, rottenTomatoes, metacritic } = omdb;
  const blocks = [];

  if (movie.poster_path) {
    blocks.push({
      type: 'photo',
      photo: { type: 'photo', media: `${TMDB_IMG_BASE}${movie.poster_path}` }
    });
  }

  blocks.push({
    type: 'table',
    is_bordered: true,
    is_striped: true,
    is_compact: true,
    cells: [
      [
        { type: 'text', text: { type: 'button', button: { text: '🎬 اسم فیلم', style: 'primary', callback_data: 'noop' } } },
        { type: 'text', text: movie.title }
      ],
      [
        { type: 'text', text: { type: 'button', button: { text: '📅 تاریخ انتشار', style: 'primary', callback_data: 'noop' } } },
        { type: 'text', text: `#year_${year}` }
      ]
    ]
  });

  blocks.push({
    type: 'buttons',
    align: 'center',
    buttons: [{ text: 'خلاصه داستان', style: 'primary', callback_data: 'noop' }]
  });

  blocks.push({
    type: 'expandable_blockquote',
    text: translatedOverview
  });

  const hasRatings = imdbRating || rottenTomatoes || metacritic;
  if (hasRatings) {
    blocks.push({
      type: 'buttons',
      align: 'center',
      buttons: [{ text: 'امتیاز ها', style: 'primary', callback_data: 'noop' }]
    });

    const tableBlock = { type: 'table', is_bordered: true, is_striped: true, is_compact: true, cells: [] };

    if (imdbRating) {
      const votesFormatted = imdbVotes ? imdbVotes.toLocaleString('en-US') : '—';
      const scoreStyle = imdbRating >= 7.0 ? 'success' : 'danger';
      tableBlock.cells.push([
        { type: 'text', text: { type: 'button', button: { text: 'IMDb', style: 'primary', callback_data: 'noop' } } },
        { type: 'text', text: { type: 'button', button: { text: `${imdbRating}/10 (${votesFormatted} رأی)`, style: scoreStyle, callback_data: 'noop' } } }
      ]);
    }
    if (rottenTomatoes) {
      const rtScore = parseInt(rottenTomatoes, 10);
      const scoreStyle = rtScore >= 70 ? 'success' : 'danger';
      tableBlock.cells.push([
        { type: 'text', text: { type: 'button', button: { text: 'Rotten Tomatoes', style: 'primary', callback_data: 'noop' } } },
        { type: 'text', text: { type: 'button', button: { text: rottenTomatoes, style: scoreStyle, callback_data: 'noop' } } }
      ]);
    }
    if (metacritic) {
      const mcScore = parseInt(metacritic, 10);
      const scoreStyle = mcScore >= 60 ? 'success' : 'danger';
      tableBlock.cells.push([
        { type: 'text', text: { type: 'button', button: { text: 'Metacritic', style: 'primary', callback_data: 'noop' } } },
        { type: 'text', text: { type: 'button', button: { text: metacritic, style: scoreStyle, callback_data: 'noop' } } }
      ]);
    }
    blocks.push(tableBlock);

    blocks.push({
      type: 'buttons',
      align: 'center',
      buttons: [{ text: 'اطلاعات بیشتر', style: 'primary', callback_data: 'noop' }]
    });
  }

  const metaTable = { type: 'table', is_bordered: true, is_striped: true, is_compact: true, cells: [] };
  if (details.genres?.length) {
    metaTable.cells.push([
      { type: 'text', text: { type: 'button', button: { text: '🎭 ژانر', style: 'primary', callback_data: 'noop' } } },
      { type: 'text', text: details.genres.map((g) => `#${g.name.replace(/\s+/g, '_')}`).join(', ') }
    ]);
  }
  if (details.runtime) {
    metaTable.cells.push([
      { type: 'text', text: { type: 'button', button: { text: '⏳ مدت فیلم', style: 'primary', callback_data: 'noop' } } },
      { type: 'text', text: `${details.runtime} دقیقه` }
    ]);
  }
  if (details.production_countries?.length) {
    metaTable.cells.push([
      { type: 'text', text: { type: 'button', button: { text: '🌍 کشور سازنده', style: 'primary', callback_data: 'noop' } } },
      { type: 'text', text: details.production_countries.map((c) => `#${c.name.replace(/\s+/g, '_')}`).join(', ') }
    ]);
  }
  if (details.spoken_languages?.length) {
    metaTable.cells.push([
      { type: 'text', text: { type: 'button', button: { text: '🗣 زبان‌ها', style: 'primary', callback_data: 'noop' } } },
      { type: 'text', text: details.spoken_languages.map((l) => `#${(l.english_name || l.name).replace(/\s+/g, '_')}`).join(', ') }
    ]);
  }
  if (details.credits?.crew?.length) {
    const directors = details.credits.crew.filter((c) => c.job === 'Director').map((d) => `#${d.name.replace(/\s+/g, '_')}`).join(', ');
    if (directors) {
      metaTable.cells.push([
        { type: 'text', text: { type: 'button', button: { text: '🎥 کارگردان', style: 'primary', callback_data: 'noop' } } },
        { type: 'text', text: directors }
      ]);
    }
  }
  if (details.credits?.cast?.length) {
    const cast = details.credits.cast.slice(0, 5).map((c) => `#${c.name.replace(/\s+/g, '_')}`).join(', ');
    if (cast) {
      metaTable.cells.push([
        { type: 'text', text: { type: 'button', button: { text: '👥 بازیگران', style: 'primary', callback_data: 'noop' } } },
        { type: 'text', text: cast }
      ]);
    }
  }
  if (metaTable.cells.length > 0) {
    blocks.push(metaTable);
  }

  const actionButtons = [];
  const trailer = details.videos?.results?.find((v) => v.type === 'Trailer' && v.site === 'YouTube');
  if (trailer) {
    actionButtons.push({
      text: '🎬 تماشای تریلر در یوتیوب',
      style: 'primary',
      url: `https://www.youtube.com/watch?v=${trailer.key}`
    });
  }

  actionButtons.push({ text: '📺 کانال ما', style: 'primary', url: 'https://t.me/FansyMovieZ' });

  if (actionButtons.length > 0) {
    blocks.push({ type: 'buttons', align: 'center', buttons: actionButtons });
  }

  return blocks;
}