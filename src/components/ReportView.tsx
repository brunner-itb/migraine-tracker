import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { db } from '../db/database';
import type { MigraineAttack } from '../db/types';

// Helper für einheitliche Zahlen-Formatierung
const formatNumber = (num: number, digits = 1) => 
  num.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export async function exportMonthlyReport(
  attacks: MigraineAttack[],
  month: Date,
  pressureData?: any // Optional override, ansonsten lädt der Service die Daten selbst
): Promise<void> {
  const attackIds = attacks.map((a) => a.id).filter((id): id is number => id !== undefined);

  // 1. Zugehörige Daten aus der DB laden (Joins)
  const [intakes, meds, cycleEvents, weatherRows] = await Promise.all([
    db.medicationIntakes.where('attackId').anyOf(attackIds).toArray(),
    db.medications.toArray(),
    db.cycleEvents.toArray(), // Lädt alle, wird gleich gefiltert
    db.weatherData.where('attackId').anyOf(attackIds).toArray(),
  ]);

  const medsMap = new Map(meds.map((m) => [m.id, m]));

  // 2. Report-Metadaten
  const monthLabel = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' }).format(month);
  const avgPain = attacks.length > 0 
    ? attacks.reduce((sum, a) => sum + a.painLevel, 0) / attacks.length 
    : 0;

  // 3. Zeilen für die Tabelle generieren
  const tableRows = attacks.map((attack) => {
    const dateStr = attack.startTime.slice(0, 10); // YYYY-MM-DD
    const startStr = attack.startTime.slice(11, 16); // HH:mm
    const endStr = attack.endTime ? attack.endTime.slice(11, 16) : 'läuft noch';
    
    // Medikation zusammenbauen
    const attackIntakes = intakes.filter(i => i.attackId === attack.id);
    const medsStrings = attackIntakes.map(intake => {
      const med = medsMap.get(intake.medicationId);
      if (!med) return 'Unbekannt';
      let str = `${med.name}`;
      if (intake.dose) str += ` ${intake.dose}`;
      if (intake.effectiveness !== null) {
        const eff = ['keine', 'leicht', 'gut', 'schmerzfrei'][intake.effectiveness];
        str += ` (Wirkung: ${eff})`;
      }
      return str;
    });

    // Zyklus / Begleitumstände für diesen Tag
    const attackCycleEvents = cycleEvents.filter(e => {
      const eventStart = e.date;
      const eventEnd = e.endDate ?? e.date;
      return eventStart <= dateStr && eventEnd >= dateStr;
    });
    
    const eventsStrings = attackCycleEvents.map(e => {
      if (e.type === 'menstruation') return 'Menstruation';
      if (e.type === 'pms') return 'PMS';
      if (e.type === 'spotting') return 'Zwischenblutung';
      if (e.type === 'cramps') return 'Unterleibskrämpfe';
      if (e.type === 'other' && /pille/i.test(e.notes)) return 'Pille vergessen';
      return e.notes || 'Sonstiges';
    });

    return [
      dateStr.split('-').reverse().join('.'), // DD.MM.YYYY
      startStr,
      endStr,
      attack.painLevel.toString(),
      medsStrings.length > 0 ? medsStrings.join('; ') : '–',
      eventsStrings.length > 0 ? eventsStrings.join(', ') : '–'
    ];
  });

  // 4. PDF Dokument aufbauen
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  
  // Header
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('Kopfschmerzkalender', 14, 16);
  
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`Zeitraum: ${monthLabel}`, 14, 23);
  doc.text(`Attacken: ${attacks.length} · Ø Schmerz: ${formatNumber(avgPain)} (Skala 1–10)`, 14, 30);

  // Tabelle
  autoTable(doc, {
    head: [['Datum', 'Start', 'Ende', 'Schmerz', 'Medikation', 'Begleitumstände']],
    body: tableRows,
    startY: 38,
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 2 },
    headStyles: { fillColor: [31, 56, 100] },
    columnStyles: {
      0: { cellWidth: 22 },
      1: { cellWidth: 15, halign: 'center' },
      2: { cellWidth: 18, halign: 'center' },
      3: { cellWidth: 16, halign: 'center' },
      4: { cellWidth: 65 },
      5: { cellWidth: 46 }
    }
  });

  // 5. Wetter-Zusammenfassung anfügen
  const validWeather = weatherRows.filter(w => w.status === 'fetched' && w.surfacePressure !== null);
  let weatherSentence = 'Keine Wetterdaten (Luftdruck) verfügbar – ein Zusammenhang mit dem Luftdruck kann nicht beurteilt werden.';
  
  if (validWeather.length > 0) {
    const avgPressure = validWeather.reduce((sum, w) => sum + w.surfacePressure!, 0) / validWeather.length;
    const below1013 = validWeather.filter(w => w.surfacePressure! < 1013).length;
    weatherSentence = `An ${below1013} von ${validWeather.length} erfassten Attacken-Tagen lag der Luftdruck unter 1013 hPa (Ø ${formatNumber(avgPressure)} hPa). Für eine belastbare Korrelation werden mehr Daten benötigt.`;
  }

  // Position für den Text (sicherstellen, dass lastAutoTable existiert)
  const finalY = (doc as any).lastAutoTable?.finalY ?? 50;
  
  doc.setFontSize(8);
  doc.setTextColor(80, 80, 80);
  doc.text('Skala Schmerz: 1 = leicht, 10 = stärkstes vorstellbares Leid.', 14, finalY + 6);
  
  const splitSentence = doc.splitTextToSize(weatherSentence, 182);
  doc.text(splitSentence, 14, finalY + 12);

  // 6. Speichern
  const fileMonth = String(month.getMonth() + 1).padStart(2, '0');
  doc.save(`kopfschmerzkalender-${month.getFullYear()}-${fileMonth}.pdf`);
}