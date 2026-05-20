import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import zhHans from './zh-Hans.json';
import zhHant from './zh-Hant.json';
import ja from './ja.json';

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    'zh-Hans': { translation: zhHans },
    'zh-Hant': { translation: zhHant },
    ja: { translation: ja },
  },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
