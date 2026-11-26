import pytest

from parse import money


@pytest.mark.parametrize("text,cents", [
    ("$12.50", 1250),
    ("EUR 1,250.00", 125000),
    ("USD 0.99", 99),
    ("-$12.50", None),      # a credit must go to review, not become a charge
    ("- 12.50", None),
    ("EUR -1,250.00", None),
    ("($50.00)", None),
    ("12", None),            # needs two decimals
])
def test_money_is_integer_minor_units_and_refuses_negatives(text, cents):
    assert money(text) == cents
