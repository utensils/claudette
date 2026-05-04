import { useState, useMemo } from "react";
import { icons } from "lucide-react";
import styles from "./IconPicker.module.css";

const CURATED_ICONS = [
  // a
  "activity","ambulance","anchor","antenna","app-window","app-window-mac","apple","archive",
  "area-chart","at-sign","atom","award",
  // b
  "badge","badge-alert","badge-check","badge-dollar-sign","badge-help","badge-info",
  "badge-minus","badge-percent","badge-plus","badge-x","banana","banknote","barcode",
  "battery","beaker","beer","bell","bell-dot","bell-minus","bell-off","bell-plus","bell-ring",
  "bike","binary","bird","bitcoin","blocks","book","book-open","bookmark","bot","box",
  "braces","brackets","brain","briefcase","brush","bug","building","building-2",
  // c
  "cactus","cake","calendar","calendar-days","camera","candlestick-chart","candy","car",
  "carrot","castle","cat","chart-area","chart-bar","chart-bar-big","chart-candlestick",
  "chart-column","chart-line","chart-no-axes-column","chart-pie","chart-scatter","chart-spline",
  "check","cherry","church","circle","circle-alert","circle-check","circle-dot","circle-x",
  "circuit-board","citrus","clipboard","clock","cloud","clover","code","code-xml","codepen",
  "codesandbox","coffee","cog","coins","columns-2","columns-3","command","compass","component",
  "construction","container","cookie","copy","cpu","credit-card","croissant","crown",
  // d
  "database","database-backup","database-zap","diamond","dice-1","dna","dna-off","dog",
  "dollar-sign","download","dribbble","droplet","droplets",
  // e
  "earth","egg","eraser","euro","external-link","eye",
  // f
  "factory","feather","fence","figma","file","file-code","file-json","file-json-2",
  "file-terminal","file-text","file-type","files","film","filter","fingerprint","fish",
  "flag","flame","flask-conical","flask-round","flower","flower-2","folder","folder-archive",
  "folder-closed","folder-code","folder-git","folder-git-2","folder-open",
  // g
  "gamepad-2","gauge","gem","ghost","gift","git-branch","git-commit-horizontal",
  "git-commit-vertical","git-compare","git-fork","git-merge","git-pull-request",
  "git-pull-request-closed","git-pull-request-draft","github","gitlab","glasses","globe",
  "globe-lock","grape","grid-2x2","grid-3x3","group",
  // h
  "hammer","hand-coins","hand-metal","hash","headphones","headset","heart","heart-handshake",
  "heart-off","heart-pulse","hexagon","highlighter","history","hospital","hotel","hourglass",
  "house",
  // i
  "ice-cream-cone","image","inbox","infinity","info",
  // k
  "key","key-round",
  // l
  "landmark","laptop","laptop-minimal","laptop-minimal-check","layers","layout-dashboard",
  "layout-grid","layout-list","layout-panel-left","layout-panel-top","layout-template",
  "leaf","library","library-big","lightbulb","line-chart","link","list","list-checks",
  "list-collapse","list-end","list-filter","list-minus","list-ordered","list-plus",
  "list-restart","list-start","list-todo","list-tree","list-video","list-x","lock",
  "lock-open","logs",
  // m
  "magnet","mail","map","map-pin","maximize","maximize-2","medal","megaphone","merge",
  "message-circle","message-circle-code","message-circle-heart","message-square","mic",
  "mic-2","mic-off","microscope","milestone","minimize","minimize-2","minus","monitor",
  "monitor-check","monitor-dot","monitor-off","monitor-smartphone","monitor-stop","monitor-x",
  "moon","mountain","mushroom","music","music-2","music-3","music-4",
  // n
  "navigation","network","notebook","npm","nut",
  // o
  "octagon","orbit",
  // p
  "package","package-check","package-minus","package-open","package-plus","package-x",
  "palette","panel-bottom","panel-left","panel-right","panel-top","paperclip","pen-tool",
  "pencil","pentagon","phone","phone-call","phone-missed","phone-off","piano","pie-chart",
  "piggy-bank","pill","pill-bottle","pin","pipette","pizza","plane","plug","plus","pocket",
  "podcast","pointer","popcorn","power","puzzle",
  // q
  "qr-code",
  // r
  "rabbit","radar","radio","radio-tower","rainbow","receipt","recycle","regex","rocket",
  "rows-2","rows-3","rss","ruler",
  // s
  "salad","sandwich","satellite","satellite-dish","scan","scatter-chart","school","scissors",
  "search","search-code","send","server","settings","share","shell","shield","shield-alert",
  "shield-ban","shield-check","shield-ellipsis","shield-half","shield-minus","shield-off",
  "shield-plus","shield-x","ship","shopping-bag","shopping-cart","sidebar","signpost","skull",
  "sliders-horizontal","sliders-vertical","smartphone","smartphone-charging","smartphone-nfc",
  "snail","snowflake","soup","sparkle","sparkles","speaker","speaker-off","sprout","square",
  "square-code","square-terminal","squirrel","star","stethoscope","store","sun","sunrise",
  "sunset","syringe",
  // t
  "table","table-2","tablet","tablet-smartphone","tablets","tag","tag-check","tags","target",
  "telescope","tent","terminal","test-tube","test-tubes","thermometer","thermometer-sun",
  "thumbs-down","thumbs-up","timer","toolbox","tornado","train-front","trash","trash-2",
  "tree-deciduous","tree-palm","tree-pine","trees","trending-down","trending-up","triangle",
  "triangle-alert","trophy","truck","turtle","tv",
  // u
  "umbrella","ungroup","unlink","unplug","upload","user","users","utensils",
  // v
  "variable","video","virus","virus-off","voicemail","volume","volume-1","volume-2","volume-x",
  // w
  "wallet","wallet-cards","wallet-minimal","wand","wand-sparkles","warehouse","water","waves",
  "webhook","webhook-off","wheat","wifi","wind","wine","workflow","worm","wrench",
  // x–z
  "x","youtube","zap","zoom-in","zoom-out",
];

function toPascalCase(kebab: string): string {
  return kebab.split("-").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("");
}

interface IconPickerProps {
  value: string;
  onChange: (icon: string) => void;
}

export function IconPicker({ value, onChange }: IconPickerProps) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return CURATED_ICONS.filter((name) => {
      if (q && !name.includes(q)) return false;
      const pascal = toPascalCase(name);
      return pascal in icons;
    });
  }, [search]);

  const selectedPascal = value ? toPascalCase(value) : null;
  const SelectedIcon = selectedPascal
    ? icons[selectedPascal as keyof typeof icons]
    : null;

  return (
    <div className={styles.wrapper}>
      <div className={styles.preview}>
        <div className={styles.previewIcon}>
          {SelectedIcon ? (
            <SelectedIcon size={18} />
          ) : value ? (
            <span>{value}</span>
          ) : null}
        </div>
        <span className={styles.previewLabel}>
          {value || "No icon selected"}
        </span>
        {value && (
          <button
            className={styles.clearBtn}
            onClick={() => onChange("")}
            type="button"
          >
            Clear
          </button>
        )}
      </div>
      <input
        className={styles.search}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search icons..."
      />
      <div className={styles.grid}>
        {filtered.length === 0 && (
          <div className={styles.emptyMsg}>No icons found</div>
        )}
        {filtered.map((name) => {
          const pascal = toPascalCase(name);
          const Icon = icons[pascal as keyof typeof icons];
          if (!Icon) return null;
          const isSelected = name === value;
          return (
            <button
              key={name}
              className={`${styles.iconBtn} ${isSelected ? styles.iconBtnSelected : ""}`}
              onClick={() => onChange(name)}
              title={name}
              type="button"
              aria-label={name}
              aria-pressed={isSelected}
            >
              <Icon size={16} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
