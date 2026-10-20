import { describe, expect, it } from "vitest";
import { isTaxInvoicePdf, parseTaxInvoiceLines } from "@/lib/import/invoice-pdf";

const LINES = [
  "Tax Invoice فاتورة ضريبية",
  "Example Building Materials Co. 300000000000003",
  "Invoice Number Invoice Date",
  "5: placeholder",
  "2020752RI 2026-05-04 19:31:59",
  "Customer VAT Number: 311111111100003",
  "PO CRSA-JCDC-PRO-200196",
  "Order No Delivery No Delivery Date Salesman No Customer No",
  "1796041 2608767,2608772 2026-05-04 5031 38609",
  "P.CODE DESCRIPTION UN U.PRICE QTY Taxable Amount VAT Rate Tax Amount Total",
  "10230B PREMIX PLASTER-SF TN 190.00 0.18 34.20 15% 5.13 39.33",
  "GREY ( BULK) الرمادي",
  "10231B TILE ADHESIVE TN 1,000.00 10.80 10,795.80 15% 1,619.37 12,415.17",
  "Total Excluding VAT 10,830.00",
  "Total VAT 15% 1,624.50",
  "Total Amount Due SAR 12,454.50",
  "Payment Terms: Net 90 Days",
];

describe("tax invoice reader", () => {
  it("reads header, lines and totals", () => {
    expect(isTaxInvoicePdf(LINES)).toBe(true);
    const r = parseTaxInvoiceLines(LINES);
    expect(r.rows).toHaveLength(2);
    const a = r.rows[0];
    expect(a.docNumber).toBe("2020752RI");
    expect(a.docDate).toBe("2026-05-04");
    expect(a.poRefs).toEqual(["CRSA-JCDC-PRO-200196"]);
    expect(a.dnRefs).toEqual(["2608767", "2608772"]);
    expect(a.currency).toBe("SAR");
    expect(a.dueDate).toBe("2026-08-02");
    expect(a.itemCode).toBe("10230B");
    expect(a.description).toContain("GREY");
    expect(a.net).toBe("34.20");
    expect(a.vat).toBe("5.13");
    expect(a.gross).toBe("39.33");
    expect(a.header?.gross).toBe("12454.50");
    expect(r.rows[1].qty).toBe("10.800");
    expect(r.rows[1].unitPrice).toBe("1000.0000");
    expect(r.control.accountRef).toBe("38609");
  });
});
