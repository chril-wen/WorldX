import i18n from "../../i18n";

const PERIOD_KEY_MAP: Record<string, string> = {
  "清晨": "time.dawn",
  "上午": "time.morning",
  "中午": "time.noon",
  "下午": "time.afternoon",
  "傍晚": "time.dusk",
  "晚上": "time.evening",
  "深夜": "time.lateNight",
};

export function translatePeriod(period: string): string {
  const key = PERIOD_KEY_MAP[period];
  if (key) return i18n.t(key);
  return period;
}

const WEATHER_ICON: Record<string, string> = {
  clear: "☀️",
  cloudy: "⛅",
  overcast: "☁️",
  fog: "🌫️",
  light_rain: "🌧️",
  heavy_rain: "🌧️",
  thunderstorm: "⛈️",
};

const WEATHER_KEY_MAP: Record<string, string> = {
  clear: "weather.clear",
  cloudy: "weather.cloudy",
  overcast: "weather.overcast",
  fog: "weather.fog",
  light_rain: "weather.light_rain",
  heavy_rain: "weather.heavy_rain",
  thunderstorm: "weather.thunderstorm",
};

export function translateWeather(kind: string): string {
  const key = WEATHER_KEY_MAP[kind];
  return key ? i18n.t(key) : kind;
}

export function weatherIcon(kind: string): string {
  return WEATHER_ICON[kind] ?? "🌤️";
}
