import type {Metadata} from "next";
import "./globals.css";
export const metadata:Metadata={title:"PourVentory – Point. Scan. Stocktake.",description:"Point. Scan. Stocktake."};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}

