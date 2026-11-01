/** Vietnamese banks with their NAPAS BIN (the 6-digit code a VietQR
 *  payload needs). The owner picks their bank once in the payment
 *  settings; checkout then renders a scannable VietQR automatically. */
export interface VnBank { bin: string; name: string }

export const VN_BANKS: VnBank[] = [
  { bin: '970436', name: 'Vietcombank' },
  { bin: '970415', name: 'VietinBank' },
  { bin: '970418', name: 'BIDV' },
  { bin: '970405', name: 'Agribank' },
  { bin: '970407', name: 'Techcombank' },
  { bin: '970422', name: 'MB Bank' },
  { bin: '970416', name: 'ACB' },
  { bin: '970432', name: 'VPBank' },
  { bin: '970423', name: 'TPBank' },
  { bin: '970403', name: 'Sacombank' },
  { bin: '970441', name: 'VIB' },
  { bin: '970443', name: 'SHB' },
  { bin: '970431', name: 'Eximbank' },
  { bin: '970437', name: 'HDBank' },
  { bin: '970448', name: 'OCB' },
  { bin: '970426', name: 'MSB' },
  { bin: '970440', name: 'SeABank' },
  { bin: '970449', name: 'LPBank (LienVietPostBank)' },
  { bin: '970409', name: 'Bac A Bank' },
  { bin: '970428', name: 'Nam A Bank' },
  { bin: '970412', name: 'PVcomBank' },
  { bin: '970419', name: 'NCB' },
  { bin: '970425', name: 'ABBANK' },
  { bin: '970438', name: 'BaoViet Bank' },
  { bin: '970433', name: 'VietBank' },
  { bin: '970400', name: 'Saigonbank' },
  { bin: '970414', name: 'OceanBank (MBV)' },
  { bin: '970406', name: 'DongA Bank' },
  { bin: '970452', name: 'KienLongBank' },
  { bin: '970430', name: 'PG Bank' },
  { bin: '970429', name: 'SCB' },
  { bin: '970457', name: 'Woori Bank' },
];
