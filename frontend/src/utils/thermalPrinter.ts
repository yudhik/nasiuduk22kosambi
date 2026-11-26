import { STORE_NAME, type OrderDetail } from '../types';
import { formatDateTime } from './format';

export type PrinterMode = 'ble' | 'rawbt' | 'browser';

export interface BluetoothPrinterState {
  connected: boolean;
  deviceName: string | null;
  supported: boolean;
}

// Common GATT Service UUIDs exposed by 58mm ESC/POS thermal Bluetooth printers (Iware X583, Zjiang, RPP02N, Gprinter, MPT-II, etc.)
const THERMAL_SERVICE_UUIDS = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '0000ae30-0000-1000-8000-00805f9b34fb',
];

interface BleCharacteristicLike {
  properties?: { write?: boolean; writeWithoutResponse?: boolean };
  writeValueWithoutResponse?: (value: BufferSource) => Promise<void>;
  writeValue: (value: BufferSource) => Promise<void>;
}

interface BleServiceLike {
  getCharacteristics: () => Promise<BleCharacteristicLike[]>;
}

interface BleServerLike {
  connected: boolean;
  connect: () => Promise<BleServerLike>;
  disconnect?: () => void;
  getPrimaryServices: () => Promise<BleServiceLike[]>;
}

interface BleDeviceLike {
  name?: string;
  gatt?: BleServerLike;
  addEventListener: (event: string, listener: () => void) => void;
}

interface NavigatorWithBluetooth {
  bluetooth?: {
    requestDevice: (options: Record<string, unknown>) => Promise<BleDeviceLike>;
  };
}

let activeDevice: BleDeviceLike | null = null;
let activeCharacteristic: BleCharacteristicLike | null = null;
const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach((fn) => fn());
}

export function subscribePrinterState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isWebBluetoothSupported(): boolean {
  return typeof navigator !== 'undefined' && Boolean((navigator as unknown as NavigatorWithBluetooth).bluetooth);
}

export function getBluetoothPrinterState(): BluetoothPrinterState {
  const connected = Boolean(activeDevice?.gatt?.connected && activeCharacteristic);
  return {
    connected,
    deviceName: connected ? activeDevice?.name || 'Thermal 58mm' : null,
    supported: isWebBluetoothSupported(),
  };
}

export function getSavedPrinterMode(): PrinterMode {
  const saved = localStorage.getItem('nota_printer_mode');
  if (saved === 'ble' || saved === 'rawbt' || saved === 'browser') {
    return saved;
  }
  return isWebBluetoothSupported() ? 'ble' : 'rawbt';
}

export function setSavedPrinterMode(mode: PrinterMode) {
  localStorage.setItem('nota_printer_mode', mode);
}

async function resolveWritableCharacteristic(device: BleDeviceLike): Promise<BleCharacteristicLike> {
  if (!device.gatt) {
    throw new Error('Perangkat Bluetooth tidak mendukung GATT.');
  }
  const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
  const services = await server.getPrimaryServices();

  for (const service of services) {
    const chars = await service.getCharacteristics();
    for (const ch of chars) {
      if (ch.properties?.writeWithoutResponse || ch.properties?.write) {
        return ch;
      }
    }
  }
  throw new Error('Tidak ditemukan karakteristik print (writable) pada printer Bluetooth ini.');
}

export async function connectBluetoothPrinter(): Promise<BluetoothPrinterState> {
  const bt = (navigator as unknown as NavigatorWithBluetooth).bluetooth;
  if (!bt) {
    throw new Error(
      'Web Bluetooth tidak didukung di browser ini. Gunakan Chrome di Android melalui HTTPS atau pilih mode RawBT.'
    );
  }

  const device = await bt.requestDevice({
    acceptAllDevices: true,
    optionalServices: THERMAL_SERVICE_UUIDS,
  });

  device.addEventListener('gattserverdisconnected', () => {
    activeCharacteristic = null;
    notifyListeners();
  });

  const characteristic = await resolveWritableCharacteristic(device);
  activeDevice = device;
  activeCharacteristic = characteristic;
  notifyListeners();
  return getBluetoothPrinterState();
}

export function disconnectBluetoothPrinter() {
  try {
    if (activeDevice?.gatt?.connected && activeDevice.gatt.disconnect) {
      activeDevice.gatt.disconnect();
    }
  } catch {
    // ignore disconnect errors
  }
  activeDevice = null;
  activeCharacteristic = null;
  notifyListeners();
}

function sanitizeAscii(text: string): string {
  return text
    .replace(/[–—]/g, '-')
    .replace(/[•]/g, '*')
    .replace(/[×]/g, 'x')
    .replace(/[^\x20-\x7E]/g, ' ');
}

function formatRpPlain(amount: number): string {
  const formatted = new Intl.NumberFormat('id-ID', {
    maximumFractionDigits: 0,
  }).format(amount);
  return `Rp ${formatted}`;
}

function padLeftRight(left: string, right: string, width = 32): string {
  const l = sanitizeAscii(left);
  const r = sanitizeAscii(right);
  const space = width - l.length - r.length;
  if (space >= 1) {
    return l + ' '.repeat(space) + r;
  }
  const maxLeft = Math.max(4, width - r.length - 1);
  return l.slice(0, maxLeft) + ' ' + r;
}

function wrapText(text: string, width = 32): string[] {
  const clean = sanitizeAscii(text).trim();
  if (!clean) return [];
  const words = clean.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if (!current) {
      current = w;
    } else if (current.length + 1 + w.length <= width) {
      current += ' ' + w;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Builds raw ESC/POS bytes tuned for 58mm thermal printers (Iware X583: 48mm printable width = 32 chars/line).
 */
export function buildEscPosReceipt58mm(order: OrderDetail): Uint8Array {
  const WIDTH = 32;
  const divider = '-'.repeat(WIDTH);
  const encoder = new TextEncoder();
  const chunks: number[] = [];

  const pushBytes = (...bytes: number[]) => chunks.push(...bytes);
  const pushLine = (line = '') => {
    const encoded = encoder.encode(sanitizeAscii(line) + '\n');
    for (const b of encoded) chunks.push(b);
  };

  // ESC @ (Initialize printer)
  pushBytes(0x1b, 0x40);

  // Center + Bold header
  pushBytes(0x1b, 0x61, 0x01); // Center
  pushBytes(0x1b, 0x45, 0x01); // Bold ON
  for (const l of wrapText(STORE_NAME, WIDTH)) {
    pushLine(l);
  }
  pushBytes(0x1b, 0x45, 0x00); // Bold OFF
  pushLine(divider);

  // Left align metadata
  pushBytes(0x1b, 0x61, 0x00);
  pushLine(padLeftRight('No. Nota', order.order_number, WIDTH));
  pushLine(padLeftRight('Waktu', formatDateTime(order.created_at), WIDTH));
  pushLine(padLeftRight('Channel', order.channel_name || 'Regular', WIDTH));
  if (order.customer_label) {
    pushLine(padLeftRight('Pelanggan', order.customer_label, WIDTH));
  }
  if (order.waiter_name) {
    pushLine(padLeftRight('Pelayan', `@${order.waiter_name}`, WIDTH));
  }
  const statusText =
    order.status === 'PAID'
      ? 'LUNAS'
      : order.status === 'VOIDED'
        ? 'DIBATALKAN'
        : 'BELUM BAYAR';
  pushLine(padLeftRight('Status', statusText, WIDTH));
  pushLine(divider);

  // Line items
  for (const item of order.items) {
    for (const l of wrapText(item.menu_name_snapshot, WIDTH)) {
      pushLine(l);
    }
    const qtyPrice = `  ${item.quantity}x ${formatRpPlain(item.unit_price_snapshot)}`;
    const subtotal = formatRpPlain(item.subtotal);
    pushLine(padLeftRight(qtyPrice, subtotal, WIDTH));
    if (item.item_note) {
      for (const l of wrapText(`  * ${item.item_note}`, WIDTH)) {
        pushLine(l);
      }
    }
  }

  if (order.notes) {
    pushLine(divider);
    for (const l of wrapText(`Catatan: ${order.notes}`, WIDTH)) {
      pushLine(l);
    }
  }

  pushLine(divider);
  // Emphasized TOTAL
  pushBytes(0x1b, 0x45, 0x01); // Bold ON
  pushBytes(0x1d, 0x21, 0x01); // Double height
  pushLine(padLeftRight('TOTAL', formatRpPlain(order.total_amount), WIDTH));
  pushBytes(0x1d, 0x21, 0x00); // Normal size
  pushBytes(0x1b, 0x45, 0x00); // Bold OFF

  if (order.paid_at) {
    pushLine(padLeftRight('Bayar', formatDateTime(order.paid_at), WIDTH));
  }
  if (order.void_reason) {
    for (const l of wrapText(`Batal: ${order.void_reason}`, WIDTH)) {
      pushLine(l);
    }
  }

  pushLine(divider);
  pushBytes(0x1b, 0x61, 0x01); // Center
  pushLine('Terima kasih!');
  // Feed 4 lines for manual tear bar on Iware X583
  pushBytes(0x1b, 0x64, 0x04);

  return new Uint8Array(chunks);
}

export function buildEscPosTestPrint58mm(): Uint8Array {
  const WIDTH = 32;
  const encoder = new TextEncoder();
  const chunks: number[] = [];
  const pushBytes = (...bytes: number[]) => chunks.push(...bytes);
  const pushLine = (line = '') => {
    const encoded = encoder.encode(sanitizeAscii(line) + '\n');
    for (const b of encoded) chunks.push(b);
  };

  pushBytes(0x1b, 0x40);
  pushBytes(0x1b, 0x61, 0x01);
  pushBytes(0x1b, 0x45, 0x01);
  for (const l of wrapText(STORE_NAME, WIDTH)) {
    pushLine(l);
  }
  pushBytes(0x1b, 0x45, 0x00);
  pushLine('-'.repeat(WIDTH));
  pushLine('TEST PRINT 58MM BERHASIL');
  pushLine('Printer Bluetooth Siap Digunakan');
  pushLine('-'.repeat(WIDTH));
  pushBytes(0x1b, 0x64, 0x04);
  return new Uint8Array(chunks);
}

async function writeBleBytes(data: Uint8Array): Promise<void> {
  if (!activeDevice) {
    throw new Error('Printer Bluetooth belum terhubung. Ketuk "Hubungkan Printer" terlebih dahulu.');
  }
  if (!activeDevice.gatt?.connected || !activeCharacteristic) {
    activeCharacteristic = await resolveWritableCharacteristic(activeDevice);
    notifyListeners();
  }

  // Send 20-byte chunks (safe BLE ATT MTU across all Android phones & Iware X583 revisions)
  const CHUNK_SIZE = 20;
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    const slice = data.slice(offset, offset + CHUNK_SIZE);
    if (activeCharacteristic.properties?.writeWithoutResponse && activeCharacteristic.writeValueWithoutResponse) {
      await activeCharacteristic.writeValueWithoutResponse(slice);
    } else {
      await activeCharacteristic.writeValue(slice);
    }
    await new Promise((resolve) => setTimeout(resolve, 18));
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function sendViaRawBt(bytes: Uint8Array): void {
  const b64 = bytesToBase64(bytes);
  window.location.href = `rawbt:base64,${b64}`;
}

export async function printOrderSilently(
  order: OrderDetail,
  mode: PrinterMode
): Promise<'printed' | 'fallback_browser'> {
  if (mode === 'browser') {
    return 'fallback_browser';
  }
  const bytes = buildEscPosReceipt58mm(order);
  if (mode === 'rawbt') {
    sendViaRawBt(bytes);
    return 'printed';
  }
  // BLE direct silent print
  await writeBleBytes(bytes);
  return 'printed';
}

export async function runThermalTestPrint(mode: PrinterMode): Promise<void> {
  const bytes = buildEscPosTestPrint58mm();
  if (mode === 'rawbt') {
    sendViaRawBt(bytes);
    return;
  }
  await writeBleBytes(bytes);
}
