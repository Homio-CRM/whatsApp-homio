export function formatPhoneNumber(input: string | number): string {

    const digits = String(input).replace(/\D/g, "")


    const withoutCountry = digits.startsWith("55") ? digits.slice(2) : digits

    if (withoutCountry.length < 11) {
        return `+55 ${withoutCountry}`
    }

    const ddd = withoutCountry.slice(0, 2)
    const numberPart = withoutCountry.slice(2, 11)
    const prefix = numberPart.slice(0, 5)
    const suffix = numberPart.slice(5)

    return `+55 ${ddd} ${prefix}-${suffix}`
}
