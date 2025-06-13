export function formatPhoneNumber(input: string | number): string {
  const digits = String(input).replace(/\D/g, '');

  // Brazil with country code
  if (digits.startsWith('55')) {
    const national = digits.slice(2);
    return formatBrazil(national, true);
  }

  // US/Canada with country code
  if (digits.startsWith('1') && digits.length === 11) {
    return formatUS(digits.slice(1));
  }

  // Mexico with country code
  if (digits.startsWith('52')) {
    const national = digits.slice(2);
    return formatMexico(national);
  }

  // Portugal with country code
  if (digits.startsWith('351')) {
    const national = digits.slice(3);
    return formatPortugal(national);
  }

  // France
  if (digits.startsWith('33') && digits.length === 11) {
    return formatFrance(digits.slice(2));
  }

  // Germany
  if (digits.startsWith('49') && digits.length > 2) {
    return formatGermany(digits.slice(2));
  }

  // Spain
  if (digits.startsWith('34') && digits.length === 11) {
    return formatSpain(digits.slice(2));
  }

  // Italy
  if (digits.startsWith('39') && digits.length > 2) {
    return formatItaly(digits.slice(2));
  }

  // US/Canada without country code
  if (digits.length === 10 || digits.length === 7) {
    return formatUS(digits);
  }

  // Domestic Brazil numbers without country code
  if (digits.length <= 11) {
    return formatBrazil(digits, false);
  }

  // Fallback to E.164
  return `+${digits}`;
}

function formatBrazil(national: string, withCountry: boolean): string {
  const country = withCountry ? '+55 ' : '';

  if (national.length === 11) {
    const ddd = national.slice(0, 2);
    const prefix = national.slice(2, 7);
    const suffix = national.slice(7);
    return `${country} ${ddd} ${prefix}-${suffix}`;
  }

  if (national.length === 10) {
    const ddd = national.slice(0, 2);
    const prefix = national.slice(2, 6);
    const suffix = national.slice(6);
    return `${country} ${ddd} ${prefix}-${suffix}`;
  }

  if (national.length === 9) {
    return `${country}${national.slice(0, 5)}-${national.slice(5)}`;
  }

  if (national.length === 8) {
    return `${country}${national.slice(0, 4)}-${national.slice(4)}`;
  }

  return `${country}${national}`;
}

function formatUS(national: string): string {
  if (national.length === 10) {
    const area = national.slice(0, 3);
    const prefix = national.slice(3, 6);
    const line = national.slice(6);
    return `+1 (${area}) ${prefix}-${line}`;
  }

  if (national.length === 7) {
    return `${national.slice(0, 3)}-${national.slice(3)}`;
  }

  return `+1 ${national}`;
}

function formatMexico(national: string): string {
  if (national.startsWith('1') && national.length === 11) {
    const area = national.slice(1, 3);
    const local = national.slice(3);
    return `+52 1 (${area}) ${local.slice(0, 4)}-${local.slice(4)}`;
  }

  if (national.length === 10) {
    const area = national.slice(0, 2);
    const local = national.slice(2);
    return `+52 (${area}) ${local.slice(0, 4)}-${local.slice(4)}`;
  }

  return `+52 ${national}`;
}

function formatPortugal(national: string): string {
  if (national.length === 9) {
    const area = national.slice(0, 2);
    const part1 = national.slice(2, 5);
    const part2 = national.slice(5);
    return `+351 (${area}) ${part1}-${part2}`;
  }
  return `+351 ${national}`;
}

function formatFrance(national: string): string {
  if (national.length === 9) {
    const first = national.charAt(0);
    const parts: string[] = [];
    for (let i = 1; i < national.length; i += 2) {
      parts.push(national.slice(i, i + 2));
    }
    return `+33 ${first} ${parts.join(' ')}`;
  }
  return `+33 ${national}`;
}

function formatGermany(national: string): string {
  const subscriber = 7;
  const areaLen = national.length - subscriber;
  if (areaLen > 0) {
    const area = national.slice(0, areaLen);
    const prefix = national.slice(areaLen, areaLen + 3);
    const suffix = national.slice(areaLen + 3);
    return `+49 (${area}) ${prefix}-${suffix}`;
  }
  return `+49 ${national}`;
}

function formatSpain(national: string): string {
  if (national.length === 9) {
    const p1 = national.slice(0, 3);
    const p2 = national.slice(3, 5);
    const p3 = national.slice(5, 7);
    const p4 = national.slice(7);
    return `+34 ${p1} ${p2} ${p3} ${p4}`;
  }
  return `+34 ${national}`;
}

function formatItaly(national: string): string {
  if (national.length === 9) {
    const area = national.slice(0, 2);
    const sub = national.slice(2);
    return `+39 (${area}) ${sub.slice(0, 3)} ${sub.slice(3)}`;
  }
  if (national.length === 10) {
    const area = national.slice(0, 3);
    const sub = national.slice(3);
    return `+39 (${area}) ${sub.slice(0, 3)}-${sub.slice(3)}`;
  }
  return `+39 ${national}`;
}
