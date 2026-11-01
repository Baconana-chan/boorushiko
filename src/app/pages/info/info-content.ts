import type { Lang } from '../../core/i18n';

export type InfoPageId = 'about' | 'help' | 'rules' | 'dmca' | 'tos';

export interface InfoLink {
  text: string;
  href: string;
}

export interface InfoSection {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
  links?: InfoLink[];
}

export interface InfoContent {
  title: string;
  lead: string;
  sections: InfoSection[];
  contactEmail?: string;
}

/** Replace with the real takedown address before the public launch. */
export const CONTACT_EMAIL = 'dmca@boorushiko.example';

const EN: Record<InfoPageId, InfoContent> = {
  about: {
    title: 'About Boorushiko',
    lead: 'A small, independent booru for hand-drawn 2D art — no AI generation, no 3D renders, no photorealistic output.',
    sections: [
      {
        title: 'What this is',
        paragraphs: [
          'Boorushiko is a tag-first gallery for illustrations, comics, sketches, pixel art and other classic 2D work. Posts are indexed by artist, character, copyright and general tags, with safe, questionable and explicit ratings.',
          'The engine is being built in the open. Bots and approved uploaders fill the catalog while the archive is young. Members can apply for upload access from the Upload page.',
        ],
      },
      {
        title: 'The name',
        paragraphs: [
          'Boorushiko started as a small word game: Nadeshiko Kagamihara from Yuru Camp△ → drop “Nade” → cross the remaining “shiko” with “booru” → Boorushiko. The site is not affiliated with the anime; it is simply a name born from a favourite character and the booru format.',
        ],
      },
      {
        title: 'Why another booru?',
        paragraphs: [
          'We wanted a quieter place for 2D art: fast tag search, clean post pages, replaceable mirrors and no recommendation algorithm deciding what you see next.',
        ],
      },
      {
        title: 'Thanks to the booru community',
        paragraphs: [
          'Boorushiko exists because other imageboards proved that a tag-based archive can be useful, searchable and community-run. Thank you to:',
        ],
        bullets: [
          'Danbooru — tag conventions, wiki culture and a public API that shaped expectations for the whole scene.',
          'Gelbooru and Safebooru — approachable browsing and search for a wider audience.',
          'yande.re and Konachan — high-resolution archives and a visual-first browsing experience.',
          'e621 — disciplined tagging and tooling that shows how far a community taxonomy can go.',
          'rule34.xxx and the wider booru family — lessons in scale, search and keeping a large catalog usable.',
        ],
      },
      {
        title: 'Art and assets',
        paragraphs: [
          'The pixel-art clock and mascot GIFs come from NekoTime, a small open-source project. They are used under the MIT license.',
        ],
        links: [
          {
            text: 'NekoTime by redtidev1918 — source and license:',
            href: 'https://github.com/redtidev1918/NekoTime',
          },
        ],
      },
      {
        title: 'Independent by design',
        paragraphs: [
          'Boorushiko is not affiliated with any of these sites. Their content, rules and do-not-post lists stay theirs; we only borrow the idea of a good tag-driven catalog.',
        ],
      },
      {
        title: 'Principles',
        bullets: [
          'No AI-generated or 3D content.',
          'Credit artists and link the source whenever possible.',
          'Respect DNP requests and takedowns.',
          'Keep the engine free software under the GPL.',
        ],
      },
    ],
  },
  help: {
    title: 'Help',
    lead: 'A short guide to searching, accounts and the things around the gallery.',
    sections: [
      {
        title: 'Search',
        bullets: [
          'tag1 tag2 — posts with both tags. Add more words to narrow the result.',
          '-tag — exclude a tag.',
          'pixel art — also tries the joined tag pixel_art; case does not matter.',
          'tag* or %tag% — prefix or substring matching.',
          'rating:s, rating:q, rating:e — filter by rating. The content filter caps which ratings are visible.',
          'order:new, order:score, order:random and score:>10 — sorting and minimum score.',
        ],
      },
      {
        title: 'Tag categories',
        paragraphs: [
          'Tags are grouped as Copyright, Character, Artist, General, Meta and Species. The colored dot and the group heading show the category; on a post page the groups are ordered from source to free-form tags.',
        ],
      },
      {
        title: 'Clock',
        paragraphs: [
          'The nekotime clock uses your device’s local time zone. It does not use the server clock or try to detect your location.',
        ],
      },
      {
        title: 'Accounts and comments',
        paragraphs: [
          'An account is only needed to comment. Comments are plain text, links are blocked and there is a short cooldown. Authors and moderators can delete comments.',
        ],
      },
      {
        title: 'Content filter',
        paragraphs: [
          'The header filter offers Safe (safe only), Mixed (safe and questionable, the default) and Adult (explicit only). Adult requires a one-time age confirmation. The choice is stored in your browser, not in your account. Sensitive tags such as loli or guro are hidden by default; the settings page (/settings) lets anyone, signed in or not, show them in this browser.',
        ],
      },
      {
        title: 'Images and sources',
        paragraphs: [
          'Images may be delivered by an external mirror. The post page lists sources; if one is down, open another source or the original page. For takedowns, see DMCA.',
        ],
      },
      {
        title: 'Uploading',
        paragraphs: [
          'Uploads are limited to bots and approved uploaders while the catalog is being built. Sign in, open the Upload page and send an application; a moderator will review it.',
        ],
      },
    ],
  },
  rules: {
    title: 'Content rules',
    lead: 'Boorushiko is a 2D-only gallery. The rules below describe what we accept, how ratings work and how moderation decisions are made.',
    sections: [
      {
        title: 'What we accept',
        bullets: [
          'Hand-drawn 2D art: illustrations, manga and comic pages, sketches, line art, pixel art and similar work.',
          'Anime, manga and cartoon styles, including original characters and fan art.',
          'Animated 2D formats when they are supported by the gallery.',
        ],
      },
      {
        title: 'What we do not accept',
        bullets: [
          'AI-generated or AI-assisted images. Metadata is a review signal, not an automatic verdict.',
          '3D renders, MMD, photorealistic output and photographs.',
          "Work by artists on the do-not-post list, or posts that ignore an artist's takedown request.",
          'Illegal content, malware, doxxing, harassment and sexual content involving minors.',
        ],
      },
      {
        title: 'Ratings and visibility',
        paragraphs: [
          'Posts use safe, questionable and explicit ratings. Safe mode shows only safe posts, Mixed shows safe and questionable, and Adult shows only explicit posts after age confirmation. The matching server filter is also applied to API requests.',
        ],
      },
      {
        title: 'Reports and moderation',
        paragraphs: [
          'Signed-in users can report a post. Moderators can reject a post with a reason, leave a note, change its rating and resolve reports. Every decision is recorded in the audit log; authors with an account are notified when their post is hidden or restored.',
        ],
      },
      {
        title: 'Metadata and review',
        paragraphs: [
          'AI and 3D metadata flags help moderators find suspicious uploads. They never hide a post on their own: a person makes the final decision.',
        ],
      },
      {
        title: 'Attribution',
        paragraphs: [
          'Credit the artist and link the source whenever it is known. If you are the artist and want a post removed, use the DMCA page and we will review it.',
        ],
      },
    ],
  },
  dmca: {
    title: 'DMCA / Takedown',
    lead: 'If you hold the rights to a work and believe a post infringes them, contact us and we will review it.',
    sections: [
      {
        title: 'What to include',
        bullets: [
          'The Boorushiko post URL or post number.',
          'The original work or source URL.',
          'Proof that you are the rights holder or authorized to act for them.',
          'Your name, contact address and a good-faith statement.',
          'A statement that the information is accurate, and your signature.',
        ],
      },
      {
        title: 'What happens next',
        paragraphs: [
          'We review the request and hide or remove the post. Where possible we notify the uploader and record the decision. Repeated infringement can lead to upload restrictions.',
        ],
      },
      {
        title: 'Counter-notice',
        paragraphs: [
          'If you believe a removal was a mistake, send a counter-notice with the same contact details and an explanation. We may restore the post if that is appropriate.',
        ],
      },
      {
        title: 'Hotlinked posts',
        paragraphs: [
          'Some posts point at an external source. Removing our page does not remove the file from the source host; contact that host as well if needed.',
        ],
      },
      {
        title: 'Artist requests',
        paragraphs: [
          'Artists can ask us not to host or index their work. Send the artist name and links; we keep a do-not-post list.',
        ],
      },
      {
        title: 'A note',
        paragraphs: ['This page describes our process in plain language; it is not legal advice.'],
      },
    ],
    contactEmail: CONTACT_EMAIL,
  },
  tos: {
    title: 'Terms of Service',
    lead: 'Short version: be decent, respect artists, and only share art you are allowed to share.',
    sections: [
      {
        title: 'Content rules',
        bullets: [
          'Hand-drawn 2D art only: illustrations, comics, sketches, pixel art. No AI-generated images, 3D renders or photorealistic output.',
          'No illegal content, malware, doxxing, harassment, spam or sexual content involving minors.',
          'Respect artist DNP lists and attribution. If you are not the artist, link the source.',
          'Explicit content must be rated correctly; it is hidden by default.',
        ],
      },
      {
        title: 'Accounts',
        paragraphs: [
          'You are responsible for your account and comments. Do not share sessions or impersonate others. Moderators may restrict accounts that break these rules.',
        ],
      },
      {
        title: 'Comments',
        paragraphs: [
          'Comments are plain text. Links are blocked; no spam, hate or personal data. Authors and moderators can delete comments.',
        ],
      },
      {
        title: 'Uploads and mirrors',
        paragraphs: [
          'Only approved uploaders and bots can upload. By uploading, you confirm that you have the right to share the file and allow Boorushiko to store, resize and mirror it for display. When backup storage is enabled, masters may be copied to Telegram for recovery.',
        ],
      },
      {
        title: 'Availability',
        paragraphs: [
          'The site is provided as-is. Mirrors, sources and third-party hosts can fail; we do not guarantee permanent availability or preservation.',
        ],
      },
      {
        title: 'Copyright and privacy',
        paragraphs: [
          'See DMCA for takedowns. We do not run ads or analytics. We use a session cookie for sign-in and localStorage for language, content-filter and search preferences; server logs may contain technical request data.',
        ],
      },
      {
        title: 'Changes',
        paragraphs: [
          'These terms may change as the project grows. The current version is always on this page. This is a plain-language draft, not legal advice.',
        ],
      },
    ],
  },
};

const RU: Record<InfoPageId, InfoContent> = {
  about: {
    title: 'О Boorushiko',
    lead: 'Небольшой независимый буру для нарисованного 2D-арта — без ИИ-генераций, 3D-рендеров и фотореализма.',
    sections: [
      {
        title: 'Что это',
        paragraphs: [
          'Boorushiko — галерея с поиском по тегам для иллюстраций, комиксов, скетчей, пиксель-арта и другого классического 2D. Посты индексируются по художнику, персонажу, копирайту и общим тегам, с рейтингами safe, questionable и explicit.',
          'Движок разрабатывается открыто. Пока каталог наполняют боты и одобренные аплоадеры. Участники могут подать заявку на доступ на странице загрузки.',
        ],
      },
      {
        title: 'Название',
        paragraphs: [
          'Boorushiko родился из игры слов: Nadeshiko Kagamihara из Yuru Camp△ → убрать «Nade» → скрестить оставшееся «shiko» с «booru» → Boorushiko. С аниме сайт не связан; это просто имя, выросшее из любимого персонажа и формата буру.',
        ],
      },
      {
        title: 'Почему ещё один буру?',
        paragraphs: [
          'Хотелось более спокойного места для 2D-арта: быстрый поиск по тегам, аккуратные страницы постов, заменяемые зеркала и никакого рекомендательного алгоритма, который решает, что показать дальше.',
        ],
      },
      {
        title: 'Спасибо сообществу буру',
        paragraphs: [
          'Boorushiko существует потому, что другие имиджборды доказали: архив с тегами может быть полезным, удобным для поиска и живущим силами сообщества. Спасибо:',
        ],
        bullets: [
          'Danbooru — за соглашения о тегах, культуру вики и публичный API, которые задали ориентиры всей сцене.',
          'Gelbooru и Safebooru — за доступный просмотр и поиск для широкой аудитории.',
          'yande.re и Konachan — за архивы в высоком разрешении и удобный визуальный просмотр.',
          'e621 — за дисциплинированное тегирование и инструменты, показывающие, насколько далеко может зайти таксономия сообщества.',
          'rule34.xxx и остальную семью буру — за уроки масштаба, поиска и поддержания большого каталога в рабочем состоянии.',
        ],
      },
      {
        title: 'Арт и ассеты',
        paragraphs: [
          'Пиксельные часы и GIF-маскоты взяты из NekoTime — небольшого open-source проекта. Они используются по лицензии MIT.',
        ],
        links: [
          {
            text: 'NekoTime от redtidev1918 — исходники и лицензия:',
            href: 'https://github.com/redtidev1918/NekoTime',
          },
        ],
      },
      {
        title: 'Независимость',
        paragraphs: [
          'Boorushiko не связан ни с одним из этих сайтов. Их контент, правила и DNP-списки остаются их; мы берём только идею хорошего каталога, построенного вокруг тегов.',
        ],
      },
      {
        title: 'Принципы',
        bullets: [
          'Никаких ИИ-генераций и 3D.',
          'Указывать художника и ссылку на источник, когда это возможно.',
          'Уважать DNP-запросы и требования об удалении.',
          'Держать движок свободным ПО под GPL.',
        ],
      },
    ],
  },
  help: {
    title: 'Помощь',
    lead: 'Коротко о поиске, аккаунтах и том, что окружает галерею.',
    sections: [
      {
        title: 'Поиск',
        bullets: [
          'tag1 tag2 — посты, где есть оба тега. Больше слов — уже результат.',
          '-tag — исключить тег.',
          'pixel art — также пробует слитный тег pixel_art; регистр не важен.',
          'tag* или %tag% — совпадение по префиксу или подстроке.',
          'rating:s, rating:q, rating:e — фильтр по рейтингу. Фильтр контента ограничивает, какие рейтинги видны.',
          'order:new, order:score, order:random и score:>10 — сортировка и минимальная оценка.',
        ],
      },
      {
        title: 'Категории тегов',
        paragraphs: [
          'Теги разделены на Copyright, Character, Artist, General, Meta и Species. Цветная точка и заголовок группы показывают категорию; на странице поста группы идут от источника к свободным тегам.',
        ],
      },
      {
        title: 'Часы',
        paragraphs: [
          'Часы nekotime показывают локальное время вашего устройства. Они не используют время сервера и не пытаются определить местоположение.',
        ],
      },
      {
        title: 'Аккаунты и комментарии',
        paragraphs: [
          'Аккаунт нужен только для комментариев. Комментарии — обычный текст, ссылки запрещены, между отправками есть небольшая пауза. Авторы и модераторы могут удалять комментарии.',
        ],
      },
      {
        title: 'Фильтр контента',
        paragraphs: [
          'В шапке есть три режима: Safe (только безопасные), Mixed (безопасные и чувствительные, по умолчанию) и Adult (только откровенные). Adult требует однократного подтверждения возраста. Выбор хранится в браузере, а не в аккаунте. Чувствительные теги вроде loli или guro по умолчанию скрыты; на странице /settings любой — с аккаунтом или без — может включить их для этого браузера.',
        ],
      },
      {
        title: 'Изображения и источники',
        paragraphs: [
          'Изображения могут отдаваться с внешнего зеркала. На странице поста перечислены источники; если одно зеркало не работает, откройте другое или страницу источника. По вопросам удаления смотрите DMCA.',
        ],
      },
      {
        title: 'Загрузка',
        paragraphs: [
          'Пока каталог наполняется, загружать могут только боты и одобренные аплоадеры. Войдите, откройте страницу загрузки и отправьте заявку — её рассмотрит модератор.',
        ],
      },
    ],
  },
  rules: {
    title: 'Правила контента',
    lead: 'Boorushiko — галерея только для 2D. Ниже описано, что мы принимаем, как работают рейтинги и как принимаются решения модераторов.',
    sections: [
      {
        title: 'Что принимается',
        bullets: [
          'Нарисованный 2D-арт: иллюстрации, страницы манги и комиксов, скетчи, line art, пиксель-арт и похожие работы.',
          'Аниме, манга и мультяшные стили, включая оригинальных персонажей и фан-арт.',
          'Анимированные 2D-форматы, когда галерея их поддерживает.',
        ],
      },
      {
        title: 'Что не принимается',
        bullets: [
          'ИИ-генерации и работы с ИИ-ассистом. Метаданные — сигнал для проверки, а не автоматический приговор.',
          '3D-рендеры, MMD, фотореализм и фотографии.',
          'Работы художников из DNP-списка и посты, игнорирующие просьбу автора об удалении.',
          'Незаконный контент, вредоносные файлы, доксинг, травля и сексуальный контент с несовершеннолетними.',
        ],
      },
      {
        title: 'Рейтинги и видимость',
        paragraphs: [
          'У постов есть рейтинги safe, questionable и explicit. Режим Safe показывает только безопасные, Mixed — безопасные и чувствительные, Adult — только откровенные после подтверждения возраста. Серверный фильтр применяется и к запросам API.',
        ],
      },
      {
        title: 'Жалобы и модерация',
        paragraphs: [
          'Вошедшие пользователи могут пожаловаться на пост. Модераторы могут отклонить пост с причиной, оставить заметку, изменить рейтинг и закрыть жалобу. Каждое решение попадает в журнал; авторы с аккаунтом получают уведомление, когда их пост скрывают или возвращают.',
        ],
      },
      {
        title: 'Метаданные и проверка',
        paragraphs: [
          'Флаги ИИ и 3D в метаданных помогают модераторам находить подозрительные загрузки. Они никогда не скрывают пост сами: финальное решение принимает человек.',
        ],
      },
      {
        title: 'Атрибуция',
        paragraphs: [
          'Указывайте художника и ссылку на источник, когда они известны. Если вы автор и хотите удалить пост, воспользуйтесь страницей DMCA — мы рассмотрим запрос.',
        ],
      },
    ],
  },
  dmca: {
    title: 'DMCA / Удаление',
    lead: 'Если вам принадлежат права на работу и вы считаете, что пост их нарушает, напишите нам — мы рассмотрим запрос.',
    sections: [
      {
        title: 'Что приложить',
        bullets: [
          'Ссылку на пост Boorushiko или его номер.',
          'Ссылку на оригинальную работу или источник.',
          'Подтверждение, что вы правообладатель или действуете от его имени.',
          'Имя, контактный адрес и заявление о добросовестности.',
          'Заявление о точности информации и вашу подпись.',
        ],
      },
      {
        title: 'Что будет дальше',
        paragraphs: [
          'Мы проверим запрос и скроем или удалим пост. По возможности уведомим загрузившего и зафиксируем решение. Повторные нарушения могут привести к ограничению загрузки.',
        ],
      },
      {
        title: 'Встречное уведомление',
        paragraphs: [
          'Если вы считаете удаление ошибкой, пришлите встречное уведомление с теми же контактами и объяснением. Если это уместно, мы можем восстановить пост.',
        ],
      },
      {
        title: 'Посты со ссылкой на источник',
        paragraphs: [
          'Некоторые посты указывают на внешний источник. Удаление нашей страницы не удаляет файл у источника; при необходимости напишите и туда.',
        ],
      },
      {
        title: 'Запросы художников',
        paragraphs: [
          'Художники могут попросить не размещать и не индексировать их работы. Пришлите имя автора и ссылки; мы ведём DNP-список.',
        ],
      },
      {
        title: 'Примечание',
        paragraphs: [
          'Эта страница описывает процесс простым языком и не является юридической консультацией.',
        ],
      },
    ],
    contactEmail: CONTACT_EMAIL,
  },
  tos: {
    title: 'Условия использования',
    lead: 'Коротко: ведите себя по-человечески, уважайте художников и выкладывайте только то, что имеете право распространять.',
    sections: [
      {
        title: 'Правила контента',
        bullets: [
          'Только нарисованный 2D-арт: иллюстрации, комиксы, скетчи, пиксель-арт. Без ИИ-генераций, 3D-рендеров и фотореализма.',
          'Запрещены незаконный контент, вредоносные файлы, доксинг, травля, спам и сексуальный контент с участием несовершеннолетних.',
          'Уважайте DNP-списки художников и указывайте авторство. Если вы не автор, дайте ссылку на источник.',
          'Откровенный контент должен иметь правильный рейтинг; по умолчанию он скрыт.',
        ],
      },
      {
        title: 'Аккаунты',
        paragraphs: [
          'Вы отвечаете за свой аккаунт и комментарии. Не передавайте сессии и не выдавайте себя за других. Модераторы могут ограничить аккаунт за нарушение правил.',
        ],
      },
      {
        title: 'Комментарии',
        paragraphs: [
          'Комментарии — обычный текст. Ссылки запрещены; также запрещены спам, враждебность и личные данные. Авторы и модераторы могут удалять комментарии.',
        ],
      },
      {
        title: 'Загрузка и зеркала',
        paragraphs: [
          'Загружать могут только одобренные аплоадеры и боты. Загружая файл, вы подтверждаете право на его распространение и разрешаете Boorushiko хранить, уменьшать и зеркалировать его для показа. Когда бэкап-хранилище включено, мастера могут копироваться в Telegram для восстановления.',
        ],
      },
      {
        title: 'Доступность',
        paragraphs: [
          'Сайт предоставляется как есть. Зеркала, источники и сторонние хостинги могут падать; мы не гарантируем постоянную доступность или сохранность.',
        ],
      },
      {
        title: 'Копирайт и приватность',
        paragraphs: [
          'По удалению смотрите DMCA. Мы не показываем рекламу и не используем аналитику. Для входа используется сессионная cookie, для языка, фильтра контента и поисковых настроек — localStorage; серверные логи могут содержать технические данные запросов.',
        ],
      },
      {
        title: 'Изменения',
        paragraphs: [
          'Эти условия могут меняться по мере развития проекта. Актуальная версия всегда на этой странице. Это черновик простым языком, а не юридическая консультация.',
        ],
      },
    ],
  },
};

export function infoContent(page: InfoPageId, lang: Lang): InfoContent {
  return (lang === 'ru' ? RU : EN)[page];
}
