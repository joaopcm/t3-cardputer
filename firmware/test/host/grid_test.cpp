#include "doctest.h"

#include <string>

#include "t3/grid.h"

TEST_CASE("grid clips at 40 columns")
{
    t3::Grid g;
    g.put(0, 36, "abcdefgh");
    CHECK(g.at(0, 36).ch == 'a');
    CHECK(g.at(0, 39).ch == 'd');
    CHECK(g.rowText(0).size() == 40);
    CHECK(g.rowText(0).substr(36) == "abcd");
    g.put(1, 40, "x");
    CHECK(g.rowText(1) == std::string(40, ' '));
}

TEST_CASE("grid replaces non-ascii with ?")
{
    t3::Grid g;
    g.put(2, 0, "a\xC3\xA9\x01z\x7f");
    CHECK(g.rowText(2).substr(0, 6) == "a???z?");
}

TEST_CASE("selectRow marks every cell in the row")
{
    t3::Grid g;
    g.put(3, 0, "hi");
    g.selectRow(3);
    for (int c = 0; c < t3::Grid::Cols; ++c) {
        CHECK(g.at(3, c).sel);
        CHECK_FALSE(g.at(2, c).sel);
        CHECK_FALSE(g.at(4, c).sel);
    }
}

TEST_CASE("rowText returns 40 chars padded with spaces")
{
    t3::Grid g;
    g.put(5, 0, "hello");
    const std::string text = g.rowText(5);
    CHECK(text.size() == 40);
    CHECK(text == "hello" + std::string(35, ' '));
}

TEST_CASE("put keeps the color and clear resets everything")
{
    t3::Grid g;
    g.put(4, 2, "ok", t3::Color::Ok);
    g.selectRow(4);
    CHECK(g.at(4, 2).fg == t3::Color::Ok);
    CHECK(g.at(4, 1).fg == t3::Color::Text);
    g.clear();
    CHECK(g.at(4, 2).ch == ' ');
    CHECK(g.at(4, 2).fg == t3::Color::Text);
    CHECK_FALSE(g.at(4, 2).sel);
}

TEST_CASE("out of range rows are ignored")
{
    t3::Grid g;
    g.put(-1, 0, "x");
    g.put(t3::Grid::Rows, 0, "x");
    g.selectRow(t3::Grid::Rows);
    CHECK(g.rowText(-1) == std::string(40, ' '));
    CHECK(g.rowText(t3::Grid::Rows) == std::string(40, ' '));
}
