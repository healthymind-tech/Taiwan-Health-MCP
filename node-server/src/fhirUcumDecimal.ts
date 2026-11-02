/**
 * org.fhir.ucum.Decimal (ucum-java 1.0.10, the version hl7-core 7.0.1 pins), ported line by line: the precision-aware
 * string arithmetic behind UcumEssenceService.getCanonicalForm. Only what the canonical form needs: construction,
 * multiply, divide, isWholeNumber, asDecimal, checkForCouldBeWholeNumber. The digit-level oddities of the Java class are
 * kept on purpose: the results are compared with validator_cli's.
 */

export class UcumException extends Error {}

const rep = (c: string, i: number): string => (i > 0 ? c.repeat(i) : "");
const dig = (c: string): number => c.charCodeAt(0) - 48;
const cdig = (i: number): string => String.fromCharCode(i + 48);
const isDigit = (c: string): boolean => c >= "0" && c <= "9";

function allZeros(s: string, start: number): boolean {
  for (let i = start; i < s.length; i++) if (s[i] !== "0") return false;
  return true;
}

function del(value: string, offset: number, length: number): string {
  return offset === 0 ? value.slice(length) : value.slice(0, offset) + value.slice(offset + length);
}

function insert(ins: string, value: string, offset: number): string {
  return offset === 0 ? ins + value : value.slice(0, offset) + ins + value.slice(offset);
}

function countSignificants(value0: string): number {
  let value = value0;
  const i = value.indexOf(".");
  if (i > -1) value = del(value, i, 1);
  while (value[0] === "0") value = value.slice(1);
  return value.length;
}

function stringAddition(s1: string, s2: string): string {
  const result: string[] = new Array(s2.length).fill("0");
  let c = 0;
  for (let i = s1.length - 1; i >= 0; i--) {
    const t = c + dig(s1[i]) + dig(s2[i]);
    result[i] = cdig(t % 10);
    c = Math.trunc(t / 10);
  }
  return result.join("");
}

function replaceChar(s: string, offset: number, c: string): string {
  return offset === 0 ? c + s.slice(1) : s.slice(0, offset) + c + s.slice(offset + 1);
}

function stringSubtraction(s10: string, s2: string): string {
  let s1 = s10;
  const result: string[] = new Array(s2.length).fill("0");
  const c = 0;
  for (let i = s1.length - 1; i >= 0; i--) {
    let t = c + (dig(s1[i]) - dig(s2[i]));
    if (t < 0) {
      t = t + 10;
      if (i === 0) throw new Error("internal logic error");
      s1 = replaceChar(s1, i - 1, cdig(dig(s1[i - 1]) - 1));
    }
    result[i] = cdig(t);
  }
  return result.join("");
}

function trimLeadingZeros(s: string): string {
  let i = 0;
  while (i < s.length && s[i] === "0") i++;
  return i === s.length ? "0" : s.slice(i);
}

export class UcumDecimal {
  private precision = 0;
  private negative = false;
  private digits = "";
  private decimal = 0;

  /** new Decimal(String) / new Decimal(String, precision). */
  constructor(value?: string | number, precision?: number) {
    if (value === undefined) return;
    const v = String(value).toLowerCase();
    if (v.includes("e")) this.setValueScientific(v);
    else this.setValueDecimal(v);
    if (precision !== undefined) this.precision = precision;
  }

  private setValueDecimal(value0: string): void {
    let value = value0;
    let dec = -1;
    this.negative = value.startsWith("-");
    if (this.negative) value = value.slice(1);
    while (value.startsWith("0") && value.length > 1) value = value.slice(1);
    for (let i = 0; i < value.length; i++) {
      if (value[i] === "." && dec === -1) dec = i;
      else if (!isDigit(value[i])) throw new UcumException(`'${value}' is not a valid decimal`);
    }
    if (dec === -1) {
      this.precision = value.length;
      this.decimal = value.length;
      this.digits = value;
    } else if (dec === value.length - 1) throw new UcumException(`'${value}' is not a valid decimal`);
    else {
      this.decimal = dec;
      this.precision = allZeros(value, 1) ? value.length - 1 : countSignificants(value);
      this.digits = del(value, this.decimal, 1);
      if (allZeros(this.digits, 0)) this.precision++;
      else {
        while (this.digits[0] === "0") {
          this.digits = this.digits.slice(1);
          this.decimal--;
        }
      }
    }
  }

  private setValueScientific(value: string): void {
    const i = value.indexOf("e");
    const s = value.slice(0, i);
    const e = value.slice(i + 1);
    if (s === "" || s === "-" || !Number.isFinite(Number(s))) throw new UcumException(`'${value}' is not a valid decimal (numeric)`);
    if (e === "" || e === "-" || !/^[+-]?\d+$/.test(e)) throw new UcumException(`'${value}' is not a valid decimal (exponent)`);
    this.setValueDecimal(s);
    for (let k = e[0] === "-" ? 1 : 0; k < e.length; k++) if (!isDigit(e[k])) throw new UcumException(`${value}' is not a valid decimal`);
    this.decimal = this.decimal + Number(e);
  }

  isZero(): boolean {
    return allZeros(this.digits, 0);
  }

  isWholeNumber(): boolean {
    return !this.asDecimal().includes(".");
  }

  asDecimal(): string {
    let result = this.digits;
    if (this.decimal !== this.digits.length) {
      if (this.decimal < 0) result = `0.${rep("0", 0 - this.decimal)}${this.digits}`;
      else if (this.decimal < result.length) result = this.decimal === 0 ? `0.${result}` : insert(".", result, this.decimal);
      else result = result + rep("0", this.decimal - result.length);
    }
    if (this.negative && !allZeros(result, 0)) result = `-${result}`;
    return result;
  }

  multiply(other: UcumDecimal): UcumDecimal {
    if (this.isZero() || other.isZero()) return new UcumDecimal("0");
    const max = Math.max(this.decimal, other.decimal);
    let s1 = rep("0", max - this.decimal + 1) + this.digits;
    let s2 = rep("0", max - other.decimal + 1) + other.digits;
    if (s1.length < s2.length) s1 = s1 + rep("0", s2.length - s1.length);
    else if (s2.length < s1.length) s2 = s2 + rep("0", s1.length - s2.length);
    if (s2 > s1) [s1, s2] = [s2, s1];
    const s: string[] = new Array(s2.length);
    for (let i = s2.length - 1; i >= 0; i--) {
      s[i] = rep("0", s2.length - (i + 1));
      let c = 0;
      for (let j = s1.length - 1; j >= 0; j--) {
        const t = c + dig(s1[j]) * dig(s2[i]);
        s[i] = insert(cdig(t % 10), s[i], 0);
        c = Math.trunc(t / 10);
      }
      // Java's `while (c > 0)` cannot run: s1 starts with a 0, so the last step leaves no carry
    }
    let t = 0;
    for (const sv of s) t = Math.max(t, sv.length);
    for (let i = 0; i < s.length; i++) s[i] = rep("0", t - s[i].length) + s[i];
    let res = "";
    let c = 0;
    for (let i = t - 1; i >= 0; i--) {
      for (let j = 0; j < s.length; j++) c = c + dig(s[j][i]);
      res = insert(cdig(c % 10), res, 0);
      c = Math.trunc(c / 10);
    }
    if (c > 0) throw new Error("internal logic error");
    let dec = res.length - (s1.length - (max + 1)) * 2;
    while (res !== "" && res !== "0" && res.startsWith("0")) {
      res = res.slice(1);
      dec--;
    }
    let prec: number;
    if (this.isWholeNumber() && other.isWholeNumber()) prec = Math.max(Math.max(this.digits.length, other.digits.length), Math.min(this.precision, other.precision));
    else if (this.isWholeNumber()) prec = other.precision;
    else if (other.isWholeNumber()) prec = this.precision;
    else prec = Math.min(this.precision, other.precision);
    while (res.length > prec && res[res.length - 1] === "0") res = del(res, res.length - 1, 1);
    const result = new UcumDecimal();
    result.setValueDecimal(res);
    result.precision = prec;
    result.decimal = dec;
    result.negative = this.negative !== other.negative;
    return result;
  }

  divide(other: UcumDecimal): UcumDecimal {
    if (this.isZero()) return new UcumDecimal("0");
    if (other.isZero()) throw new UcumException(`Attempt to divide ${this.asDecimal()} by zero`);
    const s = `0${other.digits}`;
    const m = Math.max(this.digits.length, other.digits.length) + 40;
    const tens: string[] = new Array(10);
    tens[0] = stringAddition(rep("0", s.length), s);
    for (let i = 1; i < 10; i++) tens[i] = stringAddition(tens[i - 1], s);
    let v = this.digits;
    let r = "";
    let l = 0;
    let d = this.digits.length - this.decimal + 1 - (other.digits.length - other.decimal + 1);
    while (v.length < tens[0].length) {
      v = `${v}0`;
      d++;
    }
    let w: string;
    let vi: number;
    if (v.slice(0, other.digits.length) < other.digits) {
      if (v.length === tens[0].length) {
        v = `${v}0`;
        d++;
      }
      w = v.slice(0, other.digits.length + 1);
      vi = w.length;
    } else {
      w = `0${v.slice(0, other.digits.length)}`;
      vi = w.length - 1;
    }
    let handled = false;
    const finished = (): boolean => handled && (l > m || (vi >= v.length && (w === "" || allZeros(w, 0))));
    const next = (): void => {
      if (!finished()) {
        if (vi < v.length) {
          w = w + v[vi];
          vi++;
          handled = false;
        } else {
          w = `${w}0`;
          d++;
        }
        while (w.length < tens[0].length) w = `0${w}`;
      }
    };
    while (!finished()) {
      l++;
      handled = true;
      let proc = false;
      for (let i = 8; i >= 0; i--) {
        if (tens[i] <= w) {
          proc = true;
          r = r + cdig(i + 1);
          w = trimLeadingZeros(stringSubtraction(w, tens[i]));
          next();
          break;
        }
      }
      if (!proc) {
        w = del(w, 0, 1);
        r = `${r}0`;
        next();
      }
    }
    let prec: number;
    if (this.isWholeNumber() && other.isWholeNumber() && l < m) {
      for (let i = 0; i < d; i++) {
        if (r[r.length - 1] === "0") {
          r = del(r, r.length - 1, 1);
          d--;
        }
      }
      prec = 100;
    } else {
      if (this.isWholeNumber() && other.isWholeNumber()) prec = Math.max(this.digits.length, other.digits.length);
      else if (this.isWholeNumber()) prec = Math.max(other.precision, r.length - d);
      else if (other.isWholeNumber()) prec = Math.max(this.precision, r.length - d);
      else prec = Math.max(Math.min(this.precision, other.precision), r.length - d);
      if (r.length > prec) {
        d = d - (r.length - prec);
        if (r[prec] >= "5") {
          const rs = [...r.slice(0, prec)];
          let i = rs.length - 1;
          let carry = true;
          while (carry && i >= 0) {
            if (rs[i] === "9") rs[i] = "0";
            else {
              rs[i] = String.fromCharCode(rs[i].charCodeAt(0) + 1);
              carry = false;
            }
            i--;
          }
          if (carry) {
            r = `1${rs.join("")}`;
            d++;
          } else r = rs.join("");
        } else r = r.slice(0, prec);
      }
    }
    const result = new UcumDecimal();
    result.setValueDecimal(r);
    result.decimal = r.length - d;
    result.negative = this.negative !== other.negative;
    result.precision = prec;
    return result;
  }

  checkForCouldBeWholeNumber(): void {
    if (this.precision > 17 && this.digits.length > 3) {
      let i = this.digits.length - 2;
      const ch = this.digits[i];
      if (ch === "9") {
        while (i > 0 && this.digits[i - 1] === "9") i--;
        if (i > 0 && i < this.digits.length - 3) {
          this.digits = this.digits.slice(0, i - 1) + String.fromCharCode(this.digits.charCodeAt(i - 1) + 1);
          this.precision = this.digits.length;
        }
      } else if (ch === "0") {
        while (i > 0 && this.digits[i - 1] === "0") i--;
        if (i > 0 && i < this.digits.length - 3) {
          this.digits = this.digits.slice(0, i);
          this.precision = this.digits.length;
        }
      }
    }
  }
}
