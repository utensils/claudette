import { useState, useMemo } from "react";
import { icons } from "lucide-react";
import styles from "./IconPicker.module.css";

const CURATED_ICONS = [
  "anchor","antenna","apple","archive","at-sign","atom","award","badge","badge-check",
  "banana","barcode","battery","beaker","beer","bell","bike","binary","bird","book",
  "book-open","bookmark","bot","box","braces","brackets","brain","briefcase","brush",
  "bug","building","building-2","cake","calendar","calendar-days","camera","candy","car",
  "carrot","castle","cat","check","cherry","church","circle","circle-alert","circle-check",
  "circle-dot","circle-x","circuit-board","citrus","clipboard","clock","cloud","clover",
  "code","code-xml","codepen","codesandbox","coffee","cog","command","compass","component",
  "construction","container","cookie","copy","cpu","croissant","crown","database",
  "database-backup","database-zap","diamond","dice-1","dna","dog","download","dribbble",
  "earth","egg","eraser","external-link","eye","factory","feather","fence","figma","file",
  "file-code","file-text","file-type","files","film","fish","flag","flame","flask-conical",
  "flask-round","flower","flower-2","folder","folder-archive","folder-closed","folder-code",
  "folder-git","folder-git-2","folder-open","gamepad-2","gauge","gem","ghost","gift",
  "git-branch","git-commit-horizontal","git-commit-vertical","git-compare","git-fork",
  "git-merge","git-pull-request","git-pull-request-closed","git-pull-request-draft","github",
  "gitlab","glasses","globe","globe-lock","grape","grid-2x2","grid-3x3","group","hammer",
  "hand-metal","hash","headphones","heart","heart-pulse","hexagon","highlighter","history",
  "hospital","hotel","hourglass","house","ice-cream-cone","image","inbox","infinity","info",
  "key","landmark","layers","leaf","library","library-big","lightbulb","link","lock",
  "lock-open","logs","magnet","mail","map","map-pin","medal","megaphone","merge",
  "message-circle","message-circle-code","message-circle-heart","message-square","microscope",
  "milestone","minus","monitor","moon","mountain","music","navigation","network","notebook",
  "nut","octagon","orbit","package","palette","paperclip","pen-tool","pencil","pentagon",
  "phone","pin","pipette","pizza","plane","plug","plus","pocket","podcast","pointer",
  "popcorn","power","puzzle","qr-code","rabbit","radar","radio","radio-tower","recycle",
  "regex","rocket","rss","ruler","salad","sandwich","satellite","satellite-dish","scan",
  "school","scissors","search","search-code","send","server","settings","share","shell",
  "shield","ship","shopping-cart","signpost","skull","sliders-horizontal","sliders-vertical",
  "snail","snowflake","soup","sparkle","sparkles","sprout","square","square-code","squirrel",
  "star","store","sun","tag","tags","target","telescope","tent","terminal","test-tube",
  "test-tubes","thermometer","thermometer-sun","thumbs-down","thumbs-up","timer","toolbox",
  "train-front","trash","trash-2","tree-deciduous","tree-palm","tree-pine","trees","triangle",
  "triangle-alert","trophy","truck","turtle","tv","umbrella","ungroup","unlink","unplug",
  "upload","user","users","utensils","variable","video","wand","wand-sparkles","warehouse",
  "waves","webhook","wheat","wifi","wind","wine","workflow","worm","wrench","x","youtube",
  "zap","zoom-in","zoom-out",
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
          {SelectedIcon ? <SelectedIcon size={18} /> : null}
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
            >
              <Icon size={16} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
