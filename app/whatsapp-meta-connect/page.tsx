import Link from "next/link"
import { ArrowLeft } from "lucide-react"

export default function WhatsAppMetaConnectPage() {
  return (
    <div className="w-full min-h-screen py-12 px-4 relative">
      <div
        className="fixed inset-0 pointer-events-none z-[-1]"
        style={{
          backgroundImage: `url('/whatsapp-pattern-new.png')`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
          width: "100%",
          height: "100%",
        }}
      />

      <div className="max-w-4xl w-full mx-auto">
        <Link href="/" className="inline-flex items-center mb-8 hover:underline" style={{ color: "#128c7e" }}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Voltar para comparação
        </Link>

        <div className="bg-white rounded-xl p-8 shadow-sm">
          <h1 className="text-3xl font-bold mb-6" style={{ color: "#128c7e" }}>
            Conectar WhatsApp Meta
          </h1>
          <p className="text-lg mb-4">Esta página permite conectar o WhatsApp Meta.</p>
          <p className="mb-4">Formulário de conexão será adicionado aqui.</p>
        </div>
      </div>
    </div>
  )
}
